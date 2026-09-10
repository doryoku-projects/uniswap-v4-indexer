/*
 * Parity fuzz: this repo's getAmount0/getAmount1 vs the Ponder indexer's.
 *
 * The two implementations differ in exactly one way. Ponder takes |amount|,
 * computes, then re-applies the sign. This repo passes the SIGNED amount
 * straight into getAmount{0,1}Delta. They agree only because BigInt division
 * truncates toward zero, so (-x)/d === -(x/d).
 *
 * That equivalence is load-bearing: deposited and withdrawn token parity with
 * Ponder rests on it, and it is the kind of thing that is obviously true until
 * a rounding branch is touched. So it is asserted rather than assumed.
 */
import { describe, expect, it } from "vitest";
import { getAmount0, getAmount1 } from "../src/utils/liquidityMath/liquidityAmounts";
import { SqrtPriceMath } from "../src/utils/liquidityMath/sqrtPriceMath";
import { TickMath } from "../src/utils/liquidityMath/tickMath";

// ── Ponder's formulation, transcribed from ponder/core/amounts.ts ────────────
function ponderGetAmount0(
  tickLower: bigint,
  tickUpper: bigint,
  currTick: bigint,
  amount: bigint,
  currSqrtPriceX96: bigint,
): bigint {
  const sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
  const isAdd = amount > 0n;
  const absAmount = isAdd ? amount : -amount;
  let raw = 0n;
  if (currTick < tickLower) {
    raw = SqrtPriceMath.getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, absAmount, isAdd);
  } else if (currTick < tickUpper) {
    raw = SqrtPriceMath.getAmount0Delta(currSqrtPriceX96, sqrtRatioBX96, absAmount, isAdd);
  } else {
    return 0n;
  }
  return isAdd ? raw : -raw;
}

function ponderGetAmount1(
  tickLower: bigint,
  tickUpper: bigint,
  currTick: bigint,
  amount: bigint,
  currSqrtPriceX96: bigint,
): bigint {
  const sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
  const isAdd = amount > 0n;
  const absAmount = isAdd ? amount : -amount;
  let raw = 0n;
  if (currTick < tickLower) {
    return 0n;
  } else if (currTick < tickUpper) {
    raw = SqrtPriceMath.getAmount1Delta(sqrtRatioAX96, currSqrtPriceX96, absAmount, isAdd);
  } else {
    raw = SqrtPriceMath.getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, absAmount, isAdd);
  }
  return isAdd ? raw : -raw;
}

// Deterministic PRNG so a failure is reproducible.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("amount math parity with the Ponder indexer", () => {
  it("agrees on 20k randomised cases, adds and removes", () => {
    const rng = makeRng(0xc0ffee);
    let checked = 0;
    let negatives = 0;
    let nonZero = 0;

    for (let i = 0; i < 20_000; i++) {
      // Ticks on a realistic spacing, well inside the usable range.
      const spacing = [1n, 10n, 60n, 200n][Math.floor(rng() * 4)]!;
      const centre = BigInt(Math.floor((rng() - 0.5) * 600_000));
      const width = spacing * BigInt(1 + Math.floor(rng() * 500));
      const tickLower = ((centre - width) / spacing) * spacing;
      const tickUpper = tickLower + width;
      if (tickLower <= TickMath.MIN_TICK || tickUpper >= TickMath.MAX_TICK) continue;

      // Current tick spread across below / inside / above the range.
      const where = rng();
      const currTick =
        where < 0.33
          ? tickLower - BigInt(1 + Math.floor(rng() * 5000))
          : where < 0.66
            ? tickLower + (tickUpper - tickLower) / 2n
            : tickUpper + BigInt(1 + Math.floor(rng() * 5000));
      if (currTick <= TickMath.MIN_TICK || currTick >= TickMath.MAX_TICK) continue;

      const currSqrt = TickMath.getSqrtRatioAtTick(currTick);

      // Liquidity magnitudes from dust to whale.
      const mag = BigInt(Math.floor(rng() * 30));
      const liq = (BigInt(1 + Math.floor(rng() * 1000)) * 10n ** mag) / 1n;
      const signed = rng() < 0.5 ? -liq : liq;
      if (signed < 0n) negatives++;

      const mine0 = getAmount0(tickLower, tickUpper, currTick, signed, currSqrt);
      const mine1 = getAmount1(tickLower, tickUpper, currTick, signed, currSqrt);
      const theirs0 = ponderGetAmount0(tickLower, tickUpper, currTick, signed, currSqrt);
      const theirs1 = ponderGetAmount1(tickLower, tickUpper, currTick, signed, currSqrt);

      if (mine0 !== theirs0 || mine1 !== theirs1) {
        throw new Error(
          `mismatch at i=${i}: tickLower=${tickLower} tickUpper=${tickUpper} ` +
            `currTick=${currTick} amount=${signed}\n` +
            `  amount0 mine=${mine0} ponder=${theirs0}\n` +
            `  amount1 mine=${mine1} ponder=${theirs1}`,
        );
      }
      if (mine0 !== 0n || mine1 !== 0n) nonZero++;
      checked++;
    }

    // Guard against a vacuous pass: the loop must have actually exercised
    // removes and produced non-zero amounts.
    expect(checked).toBeGreaterThan(15_000);
    expect(negatives).toBeGreaterThan(5_000);
    expect(nonZero).toBeGreaterThan(10_000);
  });

  it("a remove is the exact negation of the same-size add when rounding does not differ", () => {
    // Not universally true — an add rounds UP and a remove rounds DOWN, which is
    // the contract's own asymmetry. This pins the DIRECTION of that asymmetry so
    // a future refactor cannot silently flip it: |remove| <= |add|.
    const tickLower = -600n;
    const tickUpper = 600n;
    const currTick = 0n;
    const currSqrt = TickMath.getSqrtRatioAtTick(currTick);
    const liq = 10n ** 18n;

    const add0 = getAmount0(tickLower, tickUpper, currTick, liq, currSqrt);
    const rem0 = getAmount0(tickLower, tickUpper, currTick, -liq, currSqrt);
    const add1 = getAmount1(tickLower, tickUpper, currTick, liq, currSqrt);
    const rem1 = getAmount1(tickLower, tickUpper, currTick, -liq, currSqrt);

    expect(add0).toBeGreaterThan(0n);
    expect(rem0).toBeLessThan(0n);
    expect(-rem0).toBeLessThanOrEqual(add0);
    expect(add0 - -rem0).toBeLessThanOrEqual(2n); // rounding only, not scale
    expect(-rem1).toBeLessThanOrEqual(add1);
    expect(add1 - -rem1).toBeLessThanOrEqual(2n);
  });
});
