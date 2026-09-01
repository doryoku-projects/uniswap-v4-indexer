/*
 * Postgres rows -> subgraph-shaped response, driven by the shape the translator
 * produced.
 *
 * Pure apart from two injected loaders, so the whole reshaping surface is
 * testable with plain Maps and no database.
 */

import { UpstreamShapeError } from "./errors.js";
import type { IdCodec } from "./ids.js";
import type { FieldOut, ListPlan, ResponseShape, RootShape, RowShape } from "./shape.js";

export type Row = Record<string, unknown>;

export interface PostProcessCtx {
  readonly ids: IdCodec;
  readonly chainId: number;
  /** Batched Token primary-key lookup for the Pool.token0/token1 stitch. */
  loadTokens(envioIds: readonly string[]): Promise<Map<string, Row>>;
  /** Batched nested-list fetch: parent id -> that parent's capped, ordered rows. */
  loadList(plan: ListPlan, parentIds: readonly string[]): Promise<Map<string, Row[]>>;
  warn?(message: string): void;
}

/* -------------------------------------------------------------------------- */
/* Scalar coercion                                                            */
/* -------------------------------------------------------------------------- */

/*
 * postgres.js returns `numeric` as an exact string and `int4` as a JS number,
 * which is precisely what a subgraph emits for BigInt/BigDecimal and Int. These
 * coercers make that explicit rather than assumed, and fail loudly if a numeric
 * ever arrives as a float — which would mean silent precision loss on a uint256.
 */

function toNumericString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new UpstreamShapeError(`non-finite numeric ${v}`);
    if (!Number.isSafeInteger(v)) {
      throw new UpstreamShapeError(
        `numeric ${v} arrived as an unsafe JS number — precision has already been lost`,
      );
    }
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  throw new UpstreamShapeError(`expected numeric, got ${typeof v}`);
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new UpstreamShapeError(`expected Int, got ${JSON.stringify(v)}`);
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* Row reshaping                                                              */
/* -------------------------------------------------------------------------- */

function collectStitchIds(rows: readonly Row[], shape: RowShape, acc: Set<string>): void {
  for (const row of rows) {
    if (!row) continue;
    for (const f of shape.fields) {
      if (f.kind === "stitch") {
        const v = row[f.src];
        if (typeof v === "string" && v !== "") acc.add(v);
      }
    }
  }
}

interface Resolved {
  tokens: Map<string, Row>;
  lists: Map<string, Map<string, Row[]>>;
}

function applyField(f: FieldOut, row: Row, ctx: PostProcessCtx, res: Resolved, out: Row): void {
  switch (f.kind) {
    case "scalar": {
      const raw = row[f.src];
      if (f.coerce === "idString") {
        out[f.out] =
          raw === null || raw === undefined
            ? null
            : ctx.ids.outbound(String(raw), f.idClass ?? "opaque");
      } else if (f.coerce === "int") {
        out[f.out] = toInt(raw);
      } else if (f.coerce === "numericString") {
        out[f.out] = toNumericString(raw);
      } else {
        out[f.out] = raw ?? null;
      }
      return;
    }
    case "refId": {
      const raw = row[f.src];
      out[f.out] =
        raw === null || raw === undefined
          ? null
          : { [f.idKey]: ctx.ids.outbound(String(raw), f.idClass) };
      return;
    }
    case "object": {
      const nested = row[f.src];
      out[f.out] = nested && typeof nested === "object" ? shapeRow(nested as Row, f.row, ctx, res) : null;
      return;
    }
    case "list": {
      const byParent = res.lists.get(f.out);
      const parentId = row.id;
      const rows = byParent && typeof parentId === "string" ? byParent.get(parentId) : undefined;
      out[f.out] = (rows ?? []).map((r) => shapeRow(r, f.row, ctx, res));
      return;
    }
    case "stitch": {
      const key = row[f.src];
      if (typeof key !== "string" || key === "") {
        out[f.out] = null;
        return;
      }
      const token = res.tokens.get(key);
      if (!token) {
        // A pool referencing a Token row that does not exist is an indexer
        // invariant violation, not an ordinary empty result.
        throw new UpstreamShapeError(`pool references token ${JSON.stringify(key)} which has no row`);
      }
      out[f.out] = shapeRow(token, f.row, ctx, res);
      return;
    }
  }
}

function shapeRow(row: Row, shape: RowShape, ctx: PostProcessCtx, res: Resolved): Row {
  const out: Row = {};
  for (const f of shape.fields) applyField(f, row, ctx, res, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Reshape one root field's rows, resolving its stitches and nested lists. */
export async function shapeRoot(
  root: RootShape,
  rows: readonly Row[],
  ctx: PostProcessCtx,
): Promise<unknown> {
  const need = new Set<string>();
  collectStitchIds(rows, root.row, need);

  const parentIds = rows
    .map((r) => r.id)
    .filter((v): v is string => typeof v === "string");

  const [tokens, ...listResults] = await Promise.all([
    need.size ? ctx.loadTokens([...need]) : Promise.resolve(new Map<string, Row>()),
    ...root.lists.map((plan) =>
      parentIds.length ? ctx.loadList(plan, parentIds) : Promise.resolve(new Map<string, Row[]>()),
    ),
  ]);

  const lists = new Map<string, Map<string, Row[]>>();
  root.lists.forEach((plan, i) => {
    lists.set(plan.outKey, (listResults[i] as Map<string, Row[]>) ?? new Map());
  });

  const res: Resolved = { tokens: tokens as Map<string, Row>, lists };
  const shaped = rows.map((r) => shapeRow(r, root.row, ctx, res));
  return root.kind === "single" ? (shaped[0] ?? null) : shaped;
}

export interface MetaRaw {
  progressBlock: unknown;
  latestEventTimestamp: unknown;
}

/*
 * Envio's `_meta` view has no block timestamp of any kind, so it is synthesized
 * from the newest indexed event. For the live listener's cursor ceiling that is
 * strictly SAFER than a true block timestamp: it can never advance past data
 * the indexer actually holds.
 *
 * `block.number` maps to progressBlock, not sourceBlock or bufferBlock — those
 * run ahead of what is queryable, and the caller advances its cursor on
 * `headBlock > lastSeenBlock`.
 */
export function shapeMeta(raw: MetaRaw, ctx: PostProcessCtx): Record<string, unknown> {
  const number = toInt(raw.progressBlock) ?? 0;
  const ts = Number(toNumericString(raw.latestEventTimestamp) ?? "0");
  const timestamp = Number.isFinite(ts) ? ts : 0;
  if (timestamp === 0) {
    ctx.warn?.(
      `_meta: no indexed event for chain ${ctx.chainId} yet; block.timestamp=0 — ` +
        `a live listener will hold its cursor until the first event lands`,
    );
  }
  return {
    _meta: {
      block: { number, timestamp, hash: null },
      deployment: `envio:${ctx.chainId}:${number}`,
      hasIndexingErrors: false,
    },
  };
}

export function isMeta(shape: ResponseShape): boolean {
  return shape.kind === "meta";
}

export const __test = { toNumericString, toInt };
