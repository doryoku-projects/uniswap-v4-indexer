/*
 * The pure core: a Graph-dialect document in, SQL out.
 *
 * No database, no clock, no randomness — which is what keeps the whole
 * translation surface unit-testable offline.
 *
 * Input is parsed with the `graphql` AST, never regex. Output is SQL text, but
 * every identifier written into it comes from `schema-map.ts` or a closed enum
 * and every VALUE travels as a bound parameter, so there is nothing to escape.
 * Because each statement binds at least a LIMIT, postgres.js always uses the
 * extended protocol, and Postgres itself rejects multi-statement payloads.
 */

import {
  parse,
  Kind,
  type ArgumentNode,
  type ASTNode,
  type FieldNode,
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
} from "./schema-map.js";
import type { Coerce, FieldOut, ListPlan, ResponseShape, RootShape, RowShape } from "./shape.js";
import { ident, ParamBag } from "./sql-util.js";

export interface TranslationPlan {
  readonly shape: ResponseShape;
}

/* -------------------------------------------------------------------------- */
/* AST value resolution                                                       */
/* -------------------------------------------------------------------------- */

function resolveValue(node: ValueNode, vars: Record<string, unknown>, path: string): unknown {
  switch (node.kind) {
    case Kind.VARIABLE: {
      if (!(node.name.value in vars)) {
        throw new TranslationError(`variable $${node.name.value} was not supplied`, path, node);
      }
      return vars[node.name.value];
    }
    case Kind.INT:
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
      for (const f of node.fields) out[f.name.value] = resolveValue(f.value, vars, path);
      return out;
    }
    default:
      throw new TranslationError("unsupported value node", path, node);
  }
}

function resolveName(node: ValueNode, vars: Record<string, unknown>, path: string): string {
  const v = resolveValue(node, vars, path);
  if (typeof v !== "string") {
    throw new TranslationError(`${path} must be a name, got ${typeof v}`, path, node);
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/* Schema lookups                                                             */
/* -------------------------------------------------------------------------- */

function entityOf(name: string, node: ASTNode | undefined): EntitySpec {
  const e = ENTITIES[name];
  if (!e) throw new TranslationError(`unknown entity ${name}`, name, node);
  return e;
}

function fieldOf(entity: EntitySpec, name: string, path: string, node: ASTNode | undefined): FieldSpec {
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

/** Postgres column for a field. Reference fields carry an `_id` suffix. */
function columnOf(name: string, spec: FieldSpec): string {
  if (spec.column) return spec.column;
  if (spec.ref) return `${name}_id`;
  return name;
}

function coerceFor(spec: FieldSpec): Coerce {
  if (spec.idClass) return "idString";
  if (spec.scalar === "Int") return "int";
  if (spec.scalar === "numeric") return "numericString";
  return "raw";
}

/* -------------------------------------------------------------------------- */
/* where -> SQL predicates                                                    */
/* -------------------------------------------------------------------------- */

const SQL_OPS: Record<string, string> = {
  _eq: "=",
  _neq: "<>",
  _gt: ">",
  _gte: ">=",
  _lt: "<",
  _lte: "<=",
};

function translateWhere(
  value: unknown,
  entity: EntitySpec,
  bag: ParamBag,
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
      const inner = list.map((v) => `(${translateWhere(v, entity, bag, ids, path, node).join(" AND ")})`);
      preds.push(`(${inner.join(rawKey === "and" ? " AND " : " OR ")})`);
      continue;
    }

    // Longest suffix first, so `_not_in` beats `_in` and `_gte` beats `_gt`.
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
      throw new TranslationError(`unsupported where operator ${JSON.stringify(rawKey)}`, path, node);
    }

    const spec = fieldOf(entity, base, path, node);
    const col = ident(columnOf(base, spec));
    // A reference field filters on its FK column, whose values are the TARGET
    // entity's ids — so translation uses the target's id class, not this one's.
    const idClass: IdClass | undefined = spec.ref
      ? entityOf(spec.ref.entity, node).idClass
      : spec.idClass;

    if (op === "_in" || op === "_nin") {
      const list = Array.isArray(rawVal) ? rawVal : [rawVal];
      const mapped = list.map((v) => (idClass ? ids.inbound(String(v), idClass) : String(v)));
      const cast = spec.scalar === "numeric" && !idClass ? "::numeric[]" : "::text[]";
      const ph = `${bag.add(arrayLit(mapped))}${cast}`;
      preds.push(op === "_in" ? `${col} = ANY(${ph})` : `NOT (${col} = ANY(${ph}))`);
      continue;
    }

    const sqlOp = SQL_OPS[op];
    if (!sqlOp) {
      throw new TranslationError(`unsupported where operator ${JSON.stringify(rawKey)}`, path, node);
    }
    const mapped = idClass ? ids.inbound(String(rawVal), idClass) : rawVal;
    // Postgres compares numeric to a bound text param fine, but be explicit so
    // a string "0" is not treated as text against a numeric column.
    const cast = !idClass && spec.scalar === "numeric" ? "::numeric" : "";
    preds.push(`${col} ${sqlOp} ${bag.add(mapped)}${cast}`);
  }
  return preds;
}

function arrayLit(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Args {
  where: string[];
  orderBy: string | undefined;
  limit: number;
  offset: number | undefined;
}

function translateArgs(
  args: readonly ArgumentNode[],
  entity: EntitySpec,
  bag: ParamBag,
  ids: IdCodec,
  vars: Record<string, unknown>,
  path: string,
  node: ASTNode | undefined,
  chainId: number | undefined,
): Args {
  let where: string[] = [];
  let orderByField: string | undefined;
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
        orderByField = resolveName(a.value, vars, `${path}.orderBy`);
        break;
      case "orderDirection":
        orderDirection = resolveName(a.value, vars, `${path}.orderDirection`);
        break;
      case "first": {
        first = Number(resolveValue(a.value, vars, `${path}.first`));
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
        skip = Number(resolveValue(a.value, vars, `${path}.skip`));
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
          `${path}: time-travel queries are not available — entity history is not exposed`,
          path,
          a.value,
        );
      case "subgraphError":
        throw new TranslationError(`${path}: subgraphError is not supported`, path, a.value);
      default:
        throw new TranslationError(`${path}: unsupported argument ${JSON.stringify(n)}`, path, a.value);
    }
  }

  if (orderDirection && !orderByField) {
    throw new TranslationError(`${path}: orderDirection without orderBy`, path, node);
  }

  if (singleId !== undefined) {
    where.push(`${ident("id")} = ${bag.add(ids.inbound(String(singleId), entity.idClass))}`);
    first = 1;
  }

  // Bundle carries no chainId column — its id IS the chain id.
  if (chainId !== undefined) {
    if (entity.idClass === "bundle") {
      if (singleId === undefined) where.push(`${ident("id")} = ${bag.add(String(chainId))}`);
    } else if (entity.chainScoped) {
      where.push(`${ident("chainId")} = ${bag.add(String(chainId))}::numeric`);
    }
  }

  const order: string[] = [];
  if (orderByField) {
    const spec = fieldOf(entity, orderByField, `${path}.orderBy`, node);
    const dir = orderDirection === "desc" ? "DESC" : "ASC";
    // `tick` is the one nullable column the backend sorts on. Spell out null
    // placement so ordering matches graph-node rather than Postgres defaults.
    const nulls = orderByField === "tick" ? (dir === "DESC" ? " NULLS FIRST" : " NULLS LAST") : "";
    order.push(`${ident(columnOf(orderByField, spec))} ${dir}${nulls}`);
  }
  // An offset walk without a total order can drop or repeat rows between pages.
  if (skip !== undefined && skip > 0 && orderByField !== "id") {
    order.push(`${ident("id")} ASC`);
  }

  return {
    where,
    orderBy: order.length ? order.join(", ") : undefined,
    limit: first ?? DEFAULT_FIRST,
    offset: skip !== undefined && skip > 0 ? skip : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection sets                                                             */
/* -------------------------------------------------------------------------- */

function translateSelection(
  sel: SelectionSetNode,
  entity: EntitySpec,
  bag: ParamBag,
  ids: IdCodec,
  vars: Record<string, unknown>,
  path: string,
  lists: ListPlan[] | null,
): { columns: string[]; row: RowShape } {
  const columns: string[] = [];
  const fields: FieldOut[] = [];

  for (const s of sel.selections) {
    if (s.kind !== Kind.FIELD) {
      throw new TranslationError(`${path}: fragments are not supported`, path, s);
    }
    const node: FieldNode = s;
    const name = node.name.value;
    const out = node.alias?.value ?? name;
    if (name === "__typename") {
      throw new TranslationError(`${path}: __typename is not supported`, path, node);
    }
    const spec = fieldOf(entity, name, `${path}.${name}`, node);

    // Pool.token0 / token1: a text column holding a complete Token.id that the
    // caller selects as if it were a relation.
    if (spec.tokenStitch) {
      columns.push(ident(name));
      if (!node.selectionSet) {
        fields.push({ kind: "scalar", out, src: name, coerce: "idString", idClass: "token" });
        continue;
      }
      const inner = translateSelection(
        node.selectionSet,
        entityOf("Token", node),
        bag,
        ids,
        vars,
        `${path}.${name}`,
        null,
      );
      fields.push({ kind: "stitch", out, src: name, row: inner.row });
      continue;
    }

    // @derivedFrom array: resolved by a batched follow-up query, not inline.
    if (spec.list) {
      if (lists === null) {
        throw new TranslationError(
          `${path}.${name}: nested lists are only supported at the top level of a root field`,
          path,
          node,
        );
      }
      if (!node.selectionSet) {
        throw new TranslationError(`${path}.${name}: a list field needs a selection set`, path, node);
      }
      const target = entityOf(spec.list.entity, node);
      const back = backReference(target, entity, node, `${path}.${name}`);
      const subBag = new ParamBag();
      const sub = translateArgs(
        node.arguments ?? [],
        target,
        subBag,
        ids,
        vars,
        `${path}.${name}`,
        node,
        undefined,
      );
      if (sub.where.length) {
        throw new TranslationError(
          `${path}.${name}: filters on a nested list are not supported`,
          path,
          node,
        );
      }
      const inner = translateSelection(
        node.selectionSet,
        target,
        bag,
        ids,
        vars,
        `${path}.${name}`,
        null,
      );
      lists.push({
        outKey: out,
        entity: target.table,
        fkColumn: back,
        columns: inner.columns,
        orderBy: sub.orderBy ?? `${ident("id")} ASC`,
        limit: sub.limit,
        row: inner.row,
      });
      // The parent's own id is what the follow-up is keyed on.
      if (!columns.includes(ident("id"))) columns.push(ident("id"));
      fields.push({ kind: "list", out, src: out, row: inner.row });
      continue;
    }

    // Object relationship. `x { id }` alone collapses to the FK column.
    if (spec.ref) {
      if (!node.selectionSet) {
        throw new TranslationError(`${path}.${name}: a reference field needs a selection set`, path, node);
      }
      const target = entityOf(spec.ref.entity, node);
      const sub = node.selectionSet.selections;
      const onlyId =
        sub.length === 1 &&
        sub[0]!.kind === Kind.FIELD &&
        (sub[0] as FieldNode).name.value === "id" &&
        !(sub[0] as FieldNode).selectionSet;
      if (!onlyId) {
        throw new TranslationError(
          `${path}.${name}: only { id } is supported on a reference field`,
          path,
          node,
        );
      }
      const col = columnOf(name, spec);
      columns.push(ident(col));
      fields.push({
        kind: "refId",
        out,
        src: col,
        idKey: (sub[0] as FieldNode).alias?.value ?? "id",
        idClass: target.idClass,
      });
      continue;
    }

    if (node.selectionSet) {
      throw new TranslationError(`${path}.${name} is a scalar and cannot have a selection set`, path, node);
    }
    const col = columnOf(name, spec);
    columns.push(ident(col));
    fields.push({
      kind: "scalar",
      out,
      src: col,
      coerce: coerceFor(spec),
      ...(spec.idClass ? { idClass: spec.idClass } : {}),
    });
  }

  if (columns.length === 0) {
    throw new TranslationError(`${path}: empty selection set`, path, sel);
  }
  return { columns: dedupe(columns), row: { entity: entity.table, fields } };
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** The FK column on `child` that points back at `parent`. */
function backReference(
  child: EntitySpec,
  parent: EntitySpec,
  node: ASTNode | undefined,
  path: string,
): string {
  for (const [name, spec] of Object.entries(child.fields)) {
    if (spec.ref?.entity === parent.table) return columnOf(name, spec);
  }
  throw new TranslationError(
    `${path}: ${child.table} has no reference back to ${parent.table}`,
    path,
    node,
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function pickOperation(source: string, operationName: string | undefined): OperationDefinitionNode {
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
  if (ops.length > 1) throw new TranslationError("multiple operations require an operationName");
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
  schema: string,
  operationName?: string,
): TranslationPlan {
  const op = pickOperation(source, operationName);
  const ids = makeIdCodec(chainId);

  const metaOnly =
    op.selectionSet.selections.length === 1 &&
    op.selectionSet.selections[0]!.kind === Kind.FIELD &&
    (op.selectionSet.selections[0] as FieldNode).name.value === "_meta";
  if (metaOnly) return { shape: { kind: "meta" } };

  const roots: RootShape[] = [];

  for (const s of op.selectionSet.selections) {
    if (s.kind !== Kind.FIELD) {
      throw new TranslationError("fragments are not supported at the root", undefined, s);
    }
    const name = s.name.value;
    if (name === "_meta") {
      throw new TranslationError("_meta cannot be combined with entity queries", name, s);
    }
    const root = ROOT_FIELDS[name];
    if (!root) throw new TranslationError(`unknown root field ${JSON.stringify(name)}`, name, s);
    if (!s.selectionSet) throw new TranslationError(`${name}: missing selection set`, name, s);

    const entity = entityOf(root.entity, s);
    const bag = new ParamBag();
    const lists: ListPlan[] = [];
    const args = translateArgs(s.arguments ?? [], entity, bag, ids, variables, name, s, chainId);
    const sel = translateSelection(s.selectionSet, entity, bag, ids, variables, name, lists);

    const parts = [`SELECT ${sel.columns.join(", ")}`, `FROM ${ident(schema)}.${ident(entity.table)}`];
    if (args.where.length) parts.push(`WHERE ${args.where.join(" AND ")}`);
    if (args.orderBy) parts.push(`ORDER BY ${args.orderBy}`);
    parts.push(`LIMIT ${bag.add(args.limit)}`);
    if (args.offset !== undefined) parts.push(`OFFSET ${bag.add(args.offset)}`);

    roots.push({
      out: s.alias?.value ?? name,
      kind: root.kind,
      row: sel.row,
      sql: parts.join(" "),
      params: bag.values,
      lists,
    });
  }

  return { shape: { kind: "roots", roots } };
}

export { resolveValue as __resolveValue };
