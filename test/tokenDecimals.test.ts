/*
 * The decimals-trust rule. Guarding this is worth a test on its own: `decimals`
 * scales every token amount, so a fallback treated as a real read shifts fees
 * by a power of ten while looking entirely plausible.
 *
 * This is a regression test for a bug found by comparing against the reference
 * Ponder indexer. eUSDt-3 (0xa446938b…3e9e) is 6 decimals on-chain. A transient
 * rate limit made its `decimals()` read fail, the code fell back to 18, and
 * because the old guard only refused to cache when name AND symbol AND decimals
 * all failed, that 18 was cached permanently with no correction path. Every fee
 * on its positions came out 1e12 too small.
 */
import { describe, expect, it } from "vitest";
import { resolveDecimals } from "../src/utils/tokenMetadata";

describe("resolveDecimals", () => {
  it("trusts a normal on-chain read", () => {
    for (const d of [0, 6, 8, 18, 27, 50]) {
      expect(resolveDecimals(d)).toEqual({ decimals: d, decimalsResolved: true });
    }
  });

  it("does NOT trust a failed read — this is the eUSDt-3 case", () => {
    // A null result is a failed call, very often a transient rate limit. It
    // must fall back to 18 AND report itself as unresolved so the caller
    // refuses to cache it and retries later.
    expect(resolveDecimals(null)).toEqual({ decimals: 18, decimalsResolved: false });
    expect(resolveDecimals(undefined)).toEqual({ decimals: 18, decimalsResolved: false });
  });

  it("does NOT trust an absurd value, but still clamps it", () => {
    // A real token on Base reports ~9.1e33 decimals and crashes the indexer.
    expect(resolveDecimals(51)).toEqual({ decimals: 18, decimalsResolved: false });
    expect(resolveDecimals(9.1e33)).toEqual({ decimals: 18, decimalsResolved: false });
    expect(resolveDecimals(Number.POSITIVE_INFINITY)).toEqual({
      decimals: 18,
      decimalsResolved: false,
    });
    expect(resolveDecimals(NaN)).toEqual({ decimals: 18, decimalsResolved: false });
    expect(resolveDecimals(-1)).toEqual({ decimals: 18, decimalsResolved: false });
  });

  it("18 from a real read is distinguishable from 18 as a fallback", () => {
    // The whole point: the value alone cannot tell you, the flag can.
    expect(resolveDecimals(18).decimalsResolved).toBe(true);
    expect(resolveDecimals(null).decimalsResolved).toBe(false);
    expect(resolveDecimals(18).decimals).toBe(resolveDecimals(null).decimals);
  });
});
