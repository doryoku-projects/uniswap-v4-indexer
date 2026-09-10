/*
 * Unit tests for the position fee math. Pure arithmetic — no network, no token,
 * no Docker, so these run anywhere.
 *
 * The reference is v4-core `Position.update`:
 *   feesOwed = mulDiv(feeGrowthInside - feeGrowthInsideLast, liquidityBefore, 2^128)
 * with an UNCHECKED subtraction, and `liquidityBefore` read before the delta is
 * applied.
 */
import { describe, it, expect } from "vitest";
import { pad, toHex } from "viem";
import {
  Q128,
  absBig,
  calculateUncollectedFees,
  collectedFees,
  isDegenerate,
  isInRange,
  saltOf,
  toHuman,
  wrapSub,
} from "../src/utils/positionMath";
import { TickMath } from "../src/utils/liquidityMath/tickMath";

describe("wrapSub — the contract's unchecked subtraction", () => {
  it("is plain subtraction when it does not wrap", () => {
    expect(wrapSub(100n, 40n)).toBe(60n);
  });

  it("wraps modulo 2^256 when the accumulator has rolled over", () => {
    // fg went 2^256-5 -> 3, i.e. it advanced by 8 across the rollover.
    const before = (1n << 256n) - 5n;
    const after = 3n;
    expect(wrapSub(after, before)).toBe(8n);
  });

  it("round-trips: (a + d) - a == d for any d", () => {
    const a = (1n << 256n) - 12345n;
    for (const d of [1n, 999n, Q128, (1n << 200n) + 7n]) {
      expect(wrapSub((a + d) & ((1n << 256n) - 1n), a)).toBe(d);
    }
  });
});

describe("collectedFees — reproduces feesAccrued without a trace", () => {
  it("returns the raw growth delta when liquidity is exactly 2^128", () => {
    // fee = delta * L / 2^128, so L = 2^128 makes fee == delta. Cleanest
    // possible check that the scaling is not inverted or off by a power.
    const r = collectedFees(500n, 900n, 200n, 400n, Q128);
    expect(r.amount0).toBe(300n);
    expect(r.amount1).toBe(500n);
  });

  it("scales by liquidity over 2^128 on realistic magnitudes", () => {
    const liquidity = 1_000_000_000_000_000_000n; // 1e18
    const delta0 = 10n * Q128; // 10 token-units per unit of liquidity
    const r = collectedFees(delta0, 0n, 0n, 0n, liquidity);
    expect(r.amount0).toBe(10n * liquidity);
    expect(r.amount1).toBe(0n);
  });

  it("floors, matching mulDiv's integer division", () => {
    // delta * L = Q128 - 1  =>  floor((Q128-1)/Q128) == 0
    const r = collectedFees(Q128 - 1n, 0n, 0n, 0n, 1n);
    expect(r.amount0).toBe(0n);
  });

  it("owes nothing on a mint (liquidityBefore == 0)", () => {
    // The contract reads liquidity BEFORE applying the delta, so the very first
    // modify of a position always books zero fees no matter how far the pool's
    // fee growth has advanced.
    const r = collectedFees(999n * Q128, 999n * Q128, 0n, 0n, 0n);
    expect(r).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("owes nothing when liquidity is negative (defensive)", () => {
    expect(collectedFees(Q128, Q128, 0n, 0n, -5n)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it("books zero on the second modify in the same block", () => {
    // Both events read the SAME end-of-block baseline. Event 1 settles the
    // whole delta; event 2 sees fgNew == fgPrev and books nothing. That is the
    // correct split whenever no swap or donate interleaved between them.
    const fgEndOfBlock = 7n * Q128;
    const fgPrevSettle = 2n * Q128;
    const L0 = 1_000_000n;

    const first = collectedFees(fgEndOfBlock, fgEndOfBlock, fgPrevSettle, fgPrevSettle, L0);
    expect(first.amount0).toBe(5n * L0);

    // after event 1 the stored baseline IS fgEndOfBlock
    const second = collectedFees(fgEndOfBlock, fgEndOfBlock, fgEndOfBlock, fgEndOfBlock, L0);
    expect(second).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("drops a backwards delta instead of manufacturing a ~2^256 fee", () => {
    // A stale or missing baseline makes the accumulator appear to move back.
    // Wrapping that would yield an astronomical amount — the exact corruption
    // class this guard exists to prevent.
    const r = collectedFees(5n * Q128, 5n * Q128, 9n * Q128, 9n * Q128, 1_000_000n);
    expect(r).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("still handles a genuine rollover forward", () => {
    const before = (1n << 256n) - Q128; // one unit below rollover
    const after = wrapSub(before + 3n * Q128, 0n); // advanced 3 units, wrapping
    const r = collectedFees(after, 0n, before, 0n, 2n);
    expect(r.amount0).toBe(6n); // 3 units * L=2
  });
});

describe("calculateUncollectedFees", () => {
  it("is zero for a closed position", () => {
    expect(calculateUncollectedFees(0n, 9n * Q128, 9n * Q128, 0n, 0n)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it("computes delta * liquidity / 2^128 per token", () => {
    const r = calculateUncollectedFees(1_000n, 5n * Q128, 3n * Q128, 1n * Q128, 1n * Q128);
    expect(r.amount0).toBe(4_000n);
    expect(r.amount1).toBe(2_000n);
  });

  it("clamps a single negative leg to zero and keeps the other", () => {
    const r = calculateUncollectedFees(1_000n, 0n, 3n * Q128, 5n * Q128, 1n * Q128);
    expect(r.amount0).toBe(0n);
    expect(r.amount1).toBe(2_000n);
  });

  it("returns zero when both legs are negative", () => {
    const r = calculateUncollectedFees(1_000n, 0n, 0n, 5n * Q128, 5n * Q128);
    expect(r).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("has no magnitude cap — a large legitimate fee survives", () => {
    // A cheap 18-decimal token can legitimately accrue a huge raw amount. The
    // original subgraph capped this at 1e6 and silently dropped real fees.
    const liquidity = 10n ** 24n;
    const r = calculateUncollectedFees(liquidity, 10n ** 9n * Q128, 0n, 0n, 0n);
    expect(r.amount0).toBe(10n ** 9n * liquidity);
  });
});

describe("isDegenerate — the amounts-corruption tripwire", () => {
  it("passes a normal pool", () => {
    expect(isDegenerate(0n, 79228162514264337593543950336n)).toBe(false);
  });

  it("trips at both tick extremes", () => {
    expect(isDegenerate(TickMath.MAX_TICK, 79228162514264337593543950336n)).toBe(true);
    expect(isDegenerate(TickMath.MIN_TICK, 79228162514264337593543950336n)).toBe(true);
  });

  it("trips at both sqrt-price extremes", () => {
    expect(isDegenerate(0n, TickMath.MAX_SQRT_RATIO)).toBe(true);
    expect(isDegenerate(0n, TickMath.MIN_SQRT_RATIO)).toBe(true);
  });
});

describe("helpers", () => {
  it("saltOf matches bytes32(tokenId)", () => {
    for (const id of [0n, 1n, 133850n, 2n ** 200n]) {
      expect(saltOf(id)).toBe(pad(toHex(id), { size: 32 }));
    }
  });

  it("isInRange is inclusive of lower and exclusive of upper", () => {
    expect(isInRange(-10n, -10n, 10n)).toBe(true);
    expect(isInRange(9n, -10n, 10n)).toBe(true);
    expect(isInRange(10n, -10n, 10n)).toBe(false);
    expect(isInRange(-11n, -10n, 10n)).toBe(false);
  });

  it("toHuman scales by decimals and short-circuits zero", () => {
    expect(toHuman(0n, 18)).toBe(0);
    expect(toHuman(10n ** 18n, 18)).toBe(1);
    expect(toHuman(1_500_000n, 6n)).toBe(1.5);
  });

  it("absBig", () => {
    expect(absBig(-7n)).toBe(7n);
    expect(absBig(7n)).toBe(7n);
  });
});
