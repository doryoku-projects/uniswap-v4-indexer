/*
 * The two places a price was derived by INVERTING an already-rounded value,
 * and the wrong numbers that came out.
 *
 * Both were found by auditing a real Avalanche snapshot (blocks 56,195,376 to
 * 73,692,674) against chain state, and both are the same mistake in different
 * clothing: a reciprocal computed from a quantized operand rather than from the
 * inputs. Rounding a number to a fixed number of DECIMAL places is not a
 * relative-precision operation, so a value far from 1 loses most of its
 * significant digits — and a value that rounds to 0 takes its reciprocal down
 * with it, turning ~1e38 into 0.
 *
 *   1. `createInitialTick`  — `price1 = 1 / price0`, where `price0` had already
 *      been flattened to 0 at extreme negative ticks. 685 of 4091 ticks in the
 *      snapshot stored `price1 = 0` against a true value up to ~3.4e38.
 *   2. `sqrtPriceX96ToTokenPrices` — divided BEFORE rescaling by the decimal
 *      difference, then inverted the result. 69 of 1123 pools drifted on
 *      `token1Price`, 84 on `token0Price`, and 22 of 32 stored a hard 0.
 *
 * Neither was a decimals error: the audit found zero power-of-ten mismatches
 * anywhere in the dataset. That is the tell that distinguishes this class of
 * bug from mis-scaling, and it is why a magnitude assertion alone would not
 * have caught it.
 */
import { describe, it, expect } from "vitest";
import { BigDecimal } from "envio";
import { createInitialTick } from "../src/utils/tick";
import { sqrtPriceX96ToTokenPrices } from "../src/utils/pricing";
import type { Token } from "envio";

// v4's representable tick domain.
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const tickAt = (tickIdx: number) =>
  createInitialTick(`43114_pool_${tickIdx}`, tickIdx, "43114_pool", 0n, 0n, 43114n);

describe("createInitialTick price derivation", () => {
  it("is 1/1 at tick 0", () => {
    const t = tickAt(0);
    expect(t.price0.toString()).toBe("1");
    expect(t.price1.toString()).toBe("1");
  });

  it("gives a HUGE price1 at the extreme negative tick, not 0", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. price0 legitimately underflows here
    // — no 18-decimal value holds ~2.9e-39 — but price1 is ~3.4e38, which the
    // column stores without difficulty. Inverting the flattened price0 gave 0.
    const t = tickAt(MIN_TICK);

    expect(t.price0.toString()).toBe("0"); // genuine underflow, unavoidable
    expect(t.price1.gt(new BigDecimal("1e38"))).toBe(true);
    expect(t.price1.lt(new BigDecimal("1e39"))).toBe(true);
  });

  it("is the mirror image at the extreme positive tick", () => {
    // Here it is price1 that genuinely underflows, and price0 that must survive.
    // Asserting BOTH ends is what proves the fix is symmetric rather than a
    // special case bolted onto one side.
    const t = tickAt(MAX_TICK);

    expect(t.price1.toString()).toBe("0"); // genuine underflow
    expect(t.price0.gt(new BigDecimal("1e38"))).toBe(true);
    expect(t.price0.lt(new BigDecimal("1e39"))).toBe(true);
  });

  it("keeps price0 * price1 ~= 1 wherever both are representable", () => {
    // The reciprocal relationship still has to hold in the ordinary range —
    // deriving each side independently must not let them drift apart.
    for (const tickIdx of [-200000, -60000, -1000, -1, 1, 1000, 60000, 200000]) {
      const t = tickAt(tickIdx);
      const product = Number(t.price0.toString()) * Number(t.price1.toString());
      expect(product).toBeGreaterThan(0.999999);
      expect(product).toBeLessThan(1.000001);
    }
  });
});

// A minimal Token stand-in: this function reads only `id` and `decimals`.
const token = (id: string, decimals: bigint) =>
  ({ id, decimals } as unknown as Token);

/** |actual - expected| / expected, for comparing at relative precision. */
const relErr = (actual: BigDecimal, expected: string) => {
  const e = new BigDecimal(expected);
  return actual.minus(e).abs().div(e);
};

const NATIVE = { decimals: 18n } as never;

/*
 * A NOTE ON WHY THE INPUT BELOW IS NOT 2^96.
 *
 * The first version of these tests used `sqrtPriceX96 = 2n ** 96n` for every
 * case, on the reasoning that an exact expected value makes precision loss
 * visible. It does the opposite. At 2^96 the ratio `sqrtPrice^2 / 2^192` is
 * EXACTLY 1, so the old implementation's first `div` had nothing to round and
 * returned the same answer — every one of these assertions passed against the
 * code they were written to catch. The `price0` cases passed too: `1 / 1e18` is
 * 1e-18, which still fits inside bignumber.js's 20 decimal places.
 *
 * The bug needs a ratio far from 1, which is the ordinary case for a
 * mismatched-decimal pair. `2^96 / 1e11` puts the raw ratio at ~1e-22, below the
 * 20-dp floor, so the old code rounds it to 0 and then inverts that 0.
 */
describe("sqrtPriceX96ToTokenPrices", () => {
  // Raw ratio ~1e-22: under the 20-decimal-place floor, which is what makes
  // these cases discriminating rather than decorative.
  const SMALL_RATIO_SQRT = 2n ** 96n / 10n ** 11n;

  it("survives a raw ratio BELOW the 20-dp floor, where the old code returned 0/0", () => {
    // THE REGRESSION TEST FOR THIS FIX. Old code: price0 = 0 and price1 = 0,
    // because the ratio rounded away and `safeDiv(1, 0)` is 0. New code keeps
    // both, because the decimal scaling is folded into the operands so the
    // single division rounds at 20 dp OF THE ANSWER.
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      SMALL_RATIO_SQRT,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 6n),
      NATIVE,
    );

    // The assertion that fails on the old code: both legs are non-zero.
    expect(price1.gt(0)).toBe(true);
    expect(price0.gt(0)).toBe(true);

    // Both legs carry a tail: SMALL_RATIO_SQRT is an integer division and
    // truncates, and the code now keeps 30 significant digits rather than
    // rounding it away at 20 decimal places. Compare relatively. The tail is
    // ~2.4e-18 relative, i.e. the division is not what loses precision here.
    expect(relErr(price1, "1e-10").lt(new BigDecimal("1e-15"))).toBe(true);
    expect(relErr(price0, "1e10").lt(new BigDecimal("1e-15"))).toBe(true);
  });

  it("survives the same ratio at 18/0 decimals", () => {
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      SMALL_RATIO_SQRT,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 0n),
      NATIVE,
    );

    // Old code gave (0, 0) here as well.
    expect(price1.gt(0)).toBe(true);
    expect(price0.gt(0)).toBe(true);

    expect(relErr(price1, "1e-4").lt(new BigDecimal("1e-15"))).toBe(true);
    expect(relErr(price0, "1e4").lt(new BigDecimal("1e-15"))).toBe(true);
  });

  it("holds full precision on an 18/6 pair", () => {
    /*
     * The case that used to lose digits. With token0 at 18 decimals and token1
     * at 6, the raw sqrtPrice^2 / 2^192 ratio is ~1e-15, so quantizing it at 20
     * decimal places before the 10^12 rescale left only five or six significant
     * figures.
     *
     * sqrtPriceX96 here is 2^96 exactly, i.e. a raw ratio of exactly 1, so the
     * decimal-adjusted answer is exactly 10^(18-6) = 1e12. An exact expected
     * value makes any precision loss visible rather than arguable.
     */
    const sqrtPriceX96 = 2n ** 96n;
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      sqrtPriceX96,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 6n),
      NATIVE,
    );

    expect(price1.toString()).toBe("1000000000000");
    // And the reciprocal is exact, not a rounded inversion. Compared with `eq`
    // rather than on the string: BigDecimal renders this as "1e-12", which is
    // the same number and not the thing under test.
    expect(price0.eq(new BigDecimal("1e-12"))).toBe(true);
  });

  it("does not collapse price0 to 0 when price1 is PAST the 20-dp cliff", () => {
    /*
     * `safeDiv` rounds at 20 decimal places, so `price0` is zeroed once
     * `price1` exceeds ~2e20 — and swapping the operands does not help, because
     * the quotient itself is what is too small to represent at 20 dp. The first
     * version of this test used `2^96` at 18/0 decimals, giving `price1 = 1e18`
     * and `price0 = 1e-18`: TWO ORDERS INSIDE the cliff, so it passed against
     * the very code it was meant to indict.
     *
     * A raw ratio of 1e4 at 18/0 puts `price1` at 1e22 and `price0` at 1e-22,
     * which is past it. Only significant-digit division survives this.
     */
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      2n ** 96n * 100n, // ratio = 100^2 = 1e4
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 0n),
      NATIVE,
    );

    expect(price1.eq(new BigDecimal("1e22"))).toBe(true);
    expect(price0.gt(new BigDecimal(0))).toBe(true);
    expect(relErr(price0, "1e-22").lt(new BigDecimal("1e-15"))).toBe(true);
  });

  it("keeps a price small enough to have been zeroed outright", () => {
    // The deepest real case found on chain was a true price of 2.9e-51 stored
    // as 0. Precision must track the VALUE's magnitude, not a fixed number of
    // decimal places.
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      2n ** 96n * 10n ** 12n, // ratio = 1e24
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 0n),
      NATIVE,
    );

    expect(price1.eq(new BigDecimal("1e42"))).toBe(true);
    expect(price0.gt(new BigDecimal(0))).toBe(true);
    expect(relErr(price0, "1e-42").lt(new BigDecimal("1e-15"))).toBe(true);
  });

  it("does NOT lose precision at the large end — at least 20 decimal places, whatever the magnitude", () => {
    /*
     * The regression the significant-digit rule introduced on its own.
     *
     * `safeDiv` rounded at 20 decimal PLACES, which for a large value is far
     * more than 30 significant digits — around 47 at magnitude 1e26. So capping
     * purely at significant digits bought precision at the small end and SPENT
     * it at the large end; an audit measured a real `token1Price` going from
     * `…339.89968117276218483191` to `…339.899`.
     *
     * `exactRatio` now takes the max of both rules. With a price near 1.5e28,
     * the significant-digit rule alone would keep a single decimal place; this
     * asserts at least the 20 the old code gave, i.e. ~49 significant digits.
     */
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      (2n ** 96n * 123456789n) / 1000n,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 0n),
      NATIVE,
    );

    expect(price1.gt(new BigDecimal("1e28"))).toBe(true);
    expect(price1.decimalPlaces()).toBeGreaterThanOrEqual(20);
    // The small leg keeps its significant digits as before.
    expect(price0.gt(new BigDecimal(0))).toBe(true);
    expect(relErr(price1, "1.5241578750190521e28").lt(new BigDecimal("1e-15"))).toBe(true);
  });

  it("returns zeros for an uninitialized pool rather than dividing by zero", () => {
    // sqrtPriceX96 == 0 makes the numerator 0; both directions must degrade to
    // 0 instead of throwing or producing Infinity.
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      0n,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 6n),
      NATIVE,
    );

    expect(price1.toString()).toBe("0");
    expect(price0.toString()).toBe("0");
  });

  it("is symmetric for an equal-decimal pair", () => {
    const [price0, price1] = sqrtPriceX96ToTokenPrices(
      2n ** 96n,
      token("43114_0xtoken0", 18n),
      token("43114_0xtoken1", 18n),
      NATIVE,
    );

    expect(price1.toString()).toBe("1");
    expect(price0.toString()).toBe("1");
  });
});
