/*
 * Declarative description of how one Hasura response row becomes one
 * subgraph-shaped row. Built during translation, interpreted during
 * post-processing, so the two never drift apart.
 */

import type { IdClass } from "./ids.js";

export type Coerce = "raw" | "idString" | "int" | "numericString";

export type FieldOut =
  /** A plain column. `src` is the Hasura name, `out` the subgraph name. */
  | {
      kind: "scalar";
      out: string;
      src: string;
      coerce: Coerce;
      idClass?: IdClass;
    }
  /** `token { id }` collapsed to the `token_id` FK column — no join. */
  | { kind: "refId"; out: string; src: string; idKey: string; idClass: IdClass }
  /** An object relationship traversed for more than just `id`. */
  | { kind: "object"; out: string; src: string; row: RowShape }
  /** An array relationship (@derivedFrom), filled from a batched follow-up. */
  | { kind: "list"; out: string; src: string; row: RowShape }
  /**
   * Pool.token0 / token1: a String column the backend selects as a relation.
   * Resolved by a batched Token lookup after the main query returns.
   */
  | { kind: "stitch"; out: string; src: string; row: RowShape };

export interface RowShape {
  readonly entity: string;
  readonly fields: readonly FieldOut[];
}

/**
 * A nested @derivedFrom list, fetched as ONE batched query keyed by the parent
 * ids rather than a per-parent LATERAL.
 *
 * The declared @index directives do not exist until envio's finalizeBackfill
 * runs, so during a backfill every strategy is a sequential scan — and one scan
 * for the whole page beats one scan per parent row.
 */
export interface ListPlan {
  readonly outKey: string;
  readonly entity: string;
  /** FK column on the child pointing at the parent, e.g. `pool_id`. */
  readonly fkColumn: string;
  readonly columns: readonly string[];
  /** ORDER BY body, already quoted, e.g. `"date" DESC`. */
  readonly orderBy: string;
  /** Per-parent row cap. */
  readonly limit: number;
  readonly row: RowShape;
}

export interface RootShape {
  /** Response key the backend expects, e.g. `pools`. */
  readonly out: string;
  readonly kind: "single" | "list";
  readonly row: RowShape;
  /** SQL for this root field. */
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Nested lists to resolve after the root rows are in hand. */
  readonly lists: readonly ListPlan[];
}

export type ResponseShape =
  | { kind: "roots"; roots: readonly RootShape[] }
  | { kind: "meta" };
