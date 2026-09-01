/*
 * The pure core: a Graph-dialect document in, a Hasura document out.
 *
 * No network, no clock, no randomness — which is what makes ~90% of the risk
 * here unit-testable without a running indexer.
 *
 * Input is parsed with the `graphql` AST (never regex). Output is emitted as a
 * string, but every identifier written into it comes from `schema-map.ts` or a
 * closed enum, and every VALUE travels as a variable, so there is nothing to
 * escape and nothing to inject.
 */

import {
  parse,
  Kind,
  type ArgumentNode,
  type ASTNode,
  type FieldNode,
  type ObjectFieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";

import { TranslationError } from "./errors.js";
import { makeIdCodec, type IdClass, type IdCodec } from "./ids.js";
import {
  DEFAULT_FIRST,
  ENTITIES,
  MAX_FIRST,
  ROOT_FIELDS,
  WHERE_OPS,
  WHERE_SUFFIXES,
  type EntitySpec,
  type FieldSpec,
  type Scalar,
} from "./schema-map.js";
import type { Coerce, FieldOut, ResponseShape, RootShape, RowShape } from "./shape.js";

export interface TranslationPlan {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly shape: ResponseShape;
}

/* -------------------------------------------------------------------------- */
/* Variable bag                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Variables are re-allocated as $p0..$pn and typed from the TARGET column, not
 * from the incoming declaration. That is what kills the whole `Int!` vs
 * `numeric!` class of Hasura validation errors: the backend declares
 * `$fromDate: Int!` and `$ids: [ID!]!`, neither of which Hasura would accept
 * against its own columns.
 */
class VarBag {
  private readonly decls: string[] = [];
  readonly values: Record<string, unknown> = {};

  add(scalar: Scalar, value: unknown, isList: boolean): string {
    const name = `p${this.decls.length}`;
    const type = isList ? `[${scalar}!]!` : `${scalar}!`;
    this.decls.push(`$${name}: ${type}`);
    this.values[name] = value;
    return `$${name}`;
  }

  header(): string {
    return this.decls.length ? `(${this.decls.join(", ")})` : "";
  }
}

/* -------------------------------------------------------------------------- */
/* AST value resolution                                                       */
/* -------------------------------------------------------------------------- */

/** Resolve an AST value node against the request's variables to a JS value. */
function resolveValue(
  node: ValueNode,
  vars: Record<string, unknown>,
  path: string,
): unknown {
  switch (node.kind) {
    case Kind.VARIABLE: {
      if (!(node.name.value in vars)) {
        throw new TranslationError(
          `variable $${node.name.value} was not supplied`,
          path,
          node,
        );
      }
      return vars[node.name.value];
    }
    case Kind.INT:
      return Number(node.value);
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((v) => resolveValue(v, vars, path));
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) {
        out[f.name.value] = resolveValue(f.value, vars, path);
      }
      return out;
    }
    default:
      throw new TranslationError(`unsupported value node`, path, node);
  }
}

/** An enum/name-valued argument (orderBy, orderDirection) as a bare string. */
function resolveName(
  node: ValueNode,
  vars: Record<string, unknown>,
  path: string,
): string {
  const v = resolveValue(node, vars, path);
  if (typeof v !== "string") {
    throw new TranslationError(`${path} must be a name, got ${typeof v}`, path, node);
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/* Field resolution                                                           */
/* -------------------------------------------------------------------------- */

function entityOf(name: string, node: ASTNode | undefined): EntitySpec {
  const e = ENTITIES[name];
  if (!e) throw new TranslationError(`unknown entity ${name}`, name, node);
  return e;
}

function fieldOf(
  entity: EntitySpec,
  name: string,
  path: string,
  node: ASTNode | undefined,
): FieldSpec {
  const f = entity.fields[name];
  if (!f) {
    throw new TranslationError(
      `field ${JSON.stringify(name)} does not exist on ${entity.table}`,
      path,
      node,
    );
  }
  return f;
}

/** Hasura column name for a field: reference fields carry an `_id` suffix. */
function columnOf(name: string, spec: FieldSpec): string {
  if (spec.column) return spec.column;
  if (spec.ref) return `${name}_id`;
  return name;
}

/* -------------------------------------------------------------------------- */
/* where                                                                      */
/* -------------------------------------------------------------------------- */

function translateWhere(
  value: unknown,
  entity: EntitySpec,
  bag: VarBag,
  ids: IdCodec,
  path: string,
  node: ASTNode | undefined,
): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TranslationError(`${path}: where must be an object`, path, node);
  }
  const preds: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (rawKey === "and" || rawKey === "or") {
      const list = Array.isArray(rawVal) ? rawVal : [rawVal];
      const inner = list.map(
        (v) => `{ ${translateWhere(v, entity, bag, ids, path, node).join(", ")} }`,
      );
      preds.push(`_${rawKey}: [${inner.join(", ")}]`);
      continue;
    }

    // Longest-suffix-first so `_not_in` beats `_in` and `_gte` beats `_gt`.
    let suffix = "";
    let base = rawKey;
    for (const s of WHERE_SUFFIXES) {
      if (rawKey.endsWith(s) && rawKey.length > s.length) {
        suffix = s;
        base = rawKey.slice(0, -s.length);
        break;
      }
    }
    const op = WHERE_OPS[suffix];
    if (!op) {
      throw new TranslationError(
        `unsupported where operator ${JSON.stringify(rawKey)}`,
        path,
        node,
      );
    }

    const spec = fieldOf(entity, base, path, node);
    const column = columnOf(base, spec);
    // A reference field filters on its FK column, whose values are the target
    // entity's ids — so translation uses the TARGET's id class, not this one's.
    const idClass: IdClass | undefined = spec.ref
      ? entityOf(spec.ref.entity, node).idClass
      : spec.idClass;

    const isList = op === "_in" || op === "_nin";
    let mapped: unknown = rawVal;
    if (idClass) {
      mapped = isList
        ? (rawVal as unknown[]).map((v) => ids.inbound(String(v), idClass))
        : ids.inbound(String(rawVal), idClass);
    } else if (spec.scalar === "numeric" && !isList) {
      // Hasura numeric accepts a string; the backend already sends strings for
      // BigInt-ish filters (liquidityGross_gt: "0").
      mapped = typeof rawVal === "number" ? String(rawVal) : rawVal;
    }

    const scalar: Scalar = idClass ? "String" : spec.scalar;
    preds.push(`${column}: { ${op}: ${bag.add(scalar, mapped, isList)} }`);
  }
  return preds;
}

/* -------------------------------------------------------------------------- */
/* Selection sets                                                             */
/* -------------------------------------------------------------------------- */

function coerceFor(spec: FieldSpec): Coerce {
  if (spec.idClass) return "idString";
  if (spec.scalar === "Int") return "int";
  if (spec.scalar === "numeric") return "numericString";
  return "raw";
}

function translateSelection(
  sel: SelectionSetNode,
  entity: EntitySpec,
  bag: VarBag,
  ids: IdCodec,
  vars: Record<string, unknown>,
  path: string,
): { body: string; row: RowShape } {
  const parts: string[] = [];
  const fields: FieldOut[] = [];

  for (const s of sel.selections) {
    if (s.kind !== Kind.FIELD) {
      throw new TranslationError(
        `${path}: fragments and inline fragments are not supported`,
        path,
        s,
      );
    }
    const node: FieldNode = s;
    const name = node.name.value;
    const out = node.alias?.value ?? name;
    if (name === "__typename") {
      throw new TranslationError(`${path}: __typename is not supported`, path, node);
    }
    const spec = fieldOf(entity, name, `${path}.${name}`, node);

    // Pool.token0 / token1 — a String column selected as if it were a relation.
    if (spec.tokenStitch) {
      if (!node.selectionSet) {
        // Selected as a scalar: hand back the raw Token.id, minus the prefix.
        parts.push(name);
        fields.push({
          kind: "scalar",
          out,
          src: name,
          coerce: "idString",
          idClass: "token",
        });
        continue;
      }
      const target = entityOf("Token", node);
      const inner = translateSelection(
        node.selectionSet,
        target,
        bag,
        ids,
        vars,
        `${path}.${name}`,
      );
      // The column itself is what we join on; the sub-selection is served from
      // the batched Token fetch, so nothing extra is requested here.
      parts.push(name);
      fields.push({ kind: "stitch", out, src: name, row: inner.row });
      continue;
    }

    // Array relationship (@derivedFrom), possibly with its own arguments.
    if (spec.list) {
      if (!node.selectionSet) {
        throw new TranslationError(
          `${path}.${name}: a list field needs a selection set`,
          path,
          node,
        );
      }
      const target = entityOf(spec.list.entity, node);
      const args = translateArgs(node.arguments ?? [], target, bag, ids, vars, `${path}.${name}`, node, false);
      const inner = translateSelection(
        node.selectionSet,
        target,
        bag,
        ids,
        vars,
        `${path}.${name}`,
      );
      parts.push(`${name}${args} { ${inner.body} }`);
      fields.push({ kind: "list", out, src: name, row: inner.row });
      continue;
    }

    // Object relationship. `x { id }` alone collapses to the FK column, which
    // saves Hasura a join and is exactly what the historical pricing provider
    // needs from `token { id }`.
    if (spec.ref) {
      if (!node.selectionSet) {
        throw new TranslationError(
          `${path}.${name}: a reference field needs a selection set`,
          path,
          node,
        );
      }
      const target = entityOf(spec.ref.entity, node);
      const sub = node.selectionSet.selections;
      const onlyId =
        sub.length === 1 &&
        sub[0]!.kind === Kind.FIELD &&
        (sub[0] as FieldNode).name.value === "id" &&
        !(sub[0] as FieldNode).selectionSet;
      if (onlyId) {
        const column = columnOf(name, spec);
        parts.push(column);
        fields.push({
          kind: "refId",
          out,
          src: column,
          idKey: (sub[0] as FieldNode).alias?.value ?? "id",
          idClass: target.idClass,
        });
        continue;
      }
      const inner = translateSelection(
        node.selectionSet,
        target,
        bag,
        ids,
        vars,
        `${path}.${name}`,
      );
      parts.push(`${name} { ${inner.body} }`);
      fields.push({ kind: "object", out, src: name, row: inner.row });
      continue;
    }

    if (node.selectionSet) {
      throw new TranslationError(
        `${path}.${name} is a scalar and cannot have a selection set`,
        path,
        node,
      );
    }
    const column = columnOf(name, spec);
    parts.push(column === name ? name : `${name}: ${column}`);
    fields.push({
      kind: "scalar",
      out,
      src: name,
      coerce: coerceFor(spec),
      ...(spec.idClass ? { idClass: spec.idClass } : {}),
    });
  }

  if (parts.length === 0) {
    throw new TranslationError(`${path}: empty selection set`, path, sel);
  }
  return { body: parts.join(" "), row: { entity: entity.table, fields } };
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function translateArgs(
  args: readonly ArgumentNode[],
  entity: EntitySpec,
  bag: VarBag,
  ids: IdCodec,
  vars: Record<string, unknown>,
  path: string,
  node: ASTNode | undefined,
  isRoot: boolean,
  chainId?: number,
): string {
  let where: string[] = [];
  let orderBy: string | undefined;
  let orderDirection: string | undefined;
  let first: number | undefined;
  let skip: number | undefined;
  let singleId: unknown;

  for (const a of args) {
    const n = a.name.value;
    switch (n) {
      case "where":
        where = translateWhere(
          resolveValue(a.value, vars, `${path}.where`),
          entity,
          bag,
          ids,
          `${path}.where`,
          a.value,
        );
        break;
      case "orderBy":
        orderBy = resolveName(a.value, vars, `${path}.orderBy`);
        break;
      case "orderDirection":
        orderDirection = resolveName(a.value, vars, `${path}.orderDirection`);
        break;
      case "first": {
        const v = resolveValue(a.value, vars, `${path}.first`);
        first = Number(v);
        if (!Number.isInteger(first) || first < 0) {
          throw new TranslationError(`${path}.first must be a non-negative integer`, path, a.value);
        }
        if (first > MAX_FIRST) {
          throw new TranslationError(
            `${path}.first is ${first}; the maximum page size is ${MAX_FIRST}`,
            path,
            a.value,
          );
        }
        break;
      }
      case "skip": {
        const v = resolveValue(a.value, vars, `${path}.skip`);
        skip = Number(v);
        if (!Number.isInteger(skip) || skip < 0) {
          throw new TranslationError(`${path}.skip must be a non-negative integer`, path, a.value);
        }
        break;
      }
      case "id":
        singleId = resolveValue(a.value, vars, `${path}.id`);
        break;
      case "block":
        throw new TranslationError(
          `${path}: time-travel queries are not available — the entity-history tables are not exposed`,
          path,
          a.value,
        );
      case "subgraphError":
        throw new TranslationError(`${path}: subgraphError is not supported`, path, a.value);
      default:
        throw new TranslationError(`${path}: unsupported argument ${JSON.stringify(n)}`, path, a.value);
    }
  }

  if (orderDirection && !orderBy) {
    throw new TranslationError(`${path}: orderDirection without orderBy`, path, node);
  }

  // A singular root field: `pool(id: X)` -> `where: {id:{_eq:X}}, limit: 1`.
  if (singleId !== undefined) {
    const mapped = ids.inbound(String(singleId), entity.idClass);
    where.push(`id: { _eq: ${bag.add("String", mapped, false)} }`);
    first = 1;
  }

  // Bundle carries no chainId column — its id IS the chain id, so scoping it
  // means pinning the id. Everything else filters on the column.
  if (isRoot && chainId !== undefined) {
    if (entity.idClass === "bundle") {
      if (singleId === undefined) {
        where.push(`id: { _eq: ${bag.add("String", String(chainId), false)} }`);
      }
    } else if (entity.chainScoped) {
      where.push(`chainId: { _eq: ${bag.add("numeric", String(chainId), false)} }`);
    }
  }

  const clauses: string[] = [];
  if (where.length) clauses.push(`where: { ${where.join(", ")} }`);

  const order: string[] = [];
  if (orderBy) {
    const spec = fieldOf(entity, orderBy, `${path}.orderBy`, node);
    const column = columnOf(orderBy, spec);
    const dir = orderDirection === "desc" ? "desc" : "asc";
    // `tick` is the one nullable column the backend sorts on. Postgres and
    // graph-node disagree on default null placement, so spell it out.
    const nullable = orderBy === "tick";
    const spelled = nullable ? (dir === "desc" ? "desc_nulls_first" : "asc_nulls_last") : dir;
    order.push(`{ ${column}: ${spelled} }`);
  }
  // An offset walk without a total order can drop or repeat rows between
  // pages. The subgraph has the same hazard; we close it.
  if (skip !== undefined && skip > 0 && orderBy !== "id") {
    order.push(`{ id: asc }`);
  }
  if (order.length) clauses.push(`order_by: [${order.join(", ")}]`);

  if (isRoot) {
    clauses.push(`limit: ${bag.add("Int", first ?? DEFAULT_FIRST, false)}`);
  } else if (first !== undefined) {
    clauses.push(`limit: ${bag.add("Int", first, false)}`);
  }
  if (skip !== undefined && skip > 0) {
    clauses.push(`offset: ${bag.add("Int", skip, false)}`);
  }

  return clauses.length ? `(${clauses.join(", ")})` : "";
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function pickOperation(
  source: string,
  operationName: string | undefined,
): OperationDefinitionNode {
  const doc = parse(source);
  const ops = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (doc.definitions.length !== ops.length) {
    throw new TranslationError("fragment definitions are not supported");
  }
  if (ops.length === 0) throw new TranslationError("document contains no operation");
  if (operationName) {
    const found = ops.find((o) => o.name?.value === operationName);
    if (!found) throw new TranslationError(`no operation named ${operationName}`);
    return found;
  }
  if (ops.length > 1) {
    throw new TranslationError("multiple operations require an operationName");
  }
  const op = ops[0]!;
  if (op.operation !== "query") {
    throw new TranslationError(`${op.operation} operations are not supported`);
  }
  return op;
}

export function translate(
  source: string,
  variables: Record<string, unknown>,
  chainId: number,
  operationName?: string,
): TranslationPlan {
  const op = pickOperation(source, operationName);
  const ids = makeIdCodec(chainId);
  const bag = new VarBag();

  // `_meta` is not an entity query at all — it needs its own document.
  const metaOnly =
    op.selectionSet.selections.length === 1 &&
    op.selectionSet.selections[0]!.kind === Kind.FIELD &&
    (op.selectionSet.selections[0] as FieldNode).name.value === "_meta";
  if (metaOnly) return translateMeta(chainId);

  const roots: RootShape[] = [];
  const bodies: string[] = [];

  for (const s of op.selectionSet.selections) {
    if (s.kind !== Kind.FIELD) {
      throw new TranslationError("fragments are not supported at the root", undefined, s);
    }
    const name = s.name.value;
    if (name === "_meta") {
      throw new TranslationError("_meta cannot be combined with entity queries", name, s);
    }
    const root = ROOT_FIELDS[name];
    if (!root) {
      throw new TranslationError(
        `unknown root field ${JSON.stringify(name)}`,
        name,
        s,
      );
    }
    const entity = entityOf(root.entity, s);
    const outKey = s.alias?.value ?? name;
    if (!s.selectionSet) {
      throw new TranslationError(`${name}: missing selection set`, name, s);
    }
    const args = translateArgs(
      s.arguments ?? [],
      entity,
      bag,
      ids,
      variables,
      name,
      s,
      true,
      chainId,
    );
    const inner = translateSelection(s.selectionSet, entity, bag, ids, variables, name);
    // Alias the Hasura root back to the subgraph's plural name so the response
    // envelope needs no key rewriting — only row bodies get reshaped.
    bodies.push(`${outKey}: ${entity.table}${args} { ${inner.body} }`);
    roots.push({ out: outKey, src: outKey, kind: root.kind, row: inner.row });
  }

  const opName = op.name?.value ?? "ProxyQuery";
  const query = `query ${opName}${bag.header()} {\n  ${bodies.join("\n  ")}\n}`;
  return { query, variables: bag.values, shape: { kind: "roots", roots } };
}

/*
 * Envio's `_meta` view has no block timestamp of any kind (InternalTable.res
 * :647-661), so it is synthesized from the newest indexed event. For the live
 * listener's cursor ceiling that is strictly SAFER than a true block
 * timestamp: it can never advance past data the indexer actually holds.
 *
 * `block.number` maps to `progressBlock`, not `sourceBlock`/`bufferBlock` —
 * those run ahead of what is queryable, and the caller advances its cursor on
 * `headBlock > lastSeenBlock`.
 *
 * Note the two different chainId scalars in one document: `_meta.chainId` is a
 * true Int, every entity `chainId` is numeric. A shared variable fails.
 */
function translateMeta(chainId: number): TranslationPlan {
  const query = `query ProxyMeta($p0: Int!, $p1: numeric!) {
  meta: _meta(where: { chainId: { _eq: $p0 } }, limit: 1) { progressBlock }
  sw: Swap(where: { chainId: { _eq: $p1 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
  ml: ModifyLiquidity(where: { chainId: { _eq: $p1 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
}`;
  return {
    query,
    variables: { p0: chainId, p1: String(chainId) },
    shape: { kind: "meta" },
  };
}

export { resolveValue as __resolveValue };
export type { ObjectFieldNode };
