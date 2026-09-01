/*
 * SQL text helpers. Every identifier written into a statement comes from
 * `schema-map.ts` or a closed enum, never from request text — but these
 * validate anyway, so a future map edit cannot open an injection hole.
 */

import { InternalError } from "./errors.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote a Postgres identifier, rejecting anything that is not a plain name. */
export function ident(name: string): string {
  if (!IDENT.test(name)) {
    throw new InternalError(`refusing to build SQL with identifier ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Build a Postgres array literal.
 *
 * postgres.js binds a bare JS array as the string "a,b,c", which silently
 * matches nothing — so `_in` filters must go through an explicit literal
 * compared with `= ANY($n::text[])`.
 */
export function arrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  const parts = values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${parts.join(",")}}`;
}

/** Collects bound parameters and hands back their `$n` placeholders. */
export class ParamBag {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** A text[] bind for `= ANY(...)`. */
  addTextArray(values: readonly string[]): string {
    return `${this.add(arrayLiteral(values))}::text[]`;
  }
}
