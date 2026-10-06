/**
 * Precision tests for the price math: `ratioToBigDecimal`,
 * `sqrtPriceX96ToTokenPrices`, tick prices (`tickToPrices` / `createInitialTick`)
 * and `convertTokenToDecimal`.
 *
 * THE BUG THESE PIN. `BigDecimal` is bignumber.js on its default config
 * (DECIMAL_PLACES = 20, ROUND_HALF_UP), so every `.div` rounds to 20 FIXED
 * decimal places. Prices were built through `.div` — and ticks through 40-dp
 * steps then `toFixed(18)` — so small values lost most of their digits and
 * anything under 1e-20 (or 1e-18 for ticks) became exactly 0. On Envio prod
 * mainnet that zeroed 430 active pools' prices and put NAVI/USDC 0.19% off.
 * Prices are now the exact rational rounded once to 40 SIGNIFICANT digits.
 *
 * Every expected value below is computed INDEPENDENTLY of src: an exact bigint
 * rational (sqrtP² · 10^dec0 / (2^192 · 10^dec1), 10001^n / 10000^n, …) rounded
 * half-up to 40 significant digits by `exactSig` — its own implementation, not
 * `ratioToBigDecimal` — and compared with `BigDecimal.eq`. The legacy formulas
 * are reproduced alongside to document what the old code stored.
 *
 * Replaces test/fastExponentiation.test.ts, which diagnosed a hang in the
 * BigDecimal `fastExponentiation` that tick prices no longer use (it is gone).
 */
import { describe, it, expect } from "vitest";
import { BigDecimal, type Token } from "envio";
import {
  convertTokenToDecimal,
  exponentToBigDecimal,
  ratioToBigDecimal,
} from "../src/utils/index";
import { sqrtPriceX96ToTokenPrices } from "../src/utils/pricing";
import { createInitialTick, tickToPrices } from "../src/utils/tick";
import { NativeTokenDetails } from "../src/utils/nativeTokenDetails";
import { ADDRESS_ZERO } from "../src/utils/constants";

const Q192 = 2n ** 192n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// ---------------------------------------------------------------------------
// Independent reference arithmetic
// ---------------------------------------------------------------------------

/** a/b >= 10^exp, decided exactly (a, b > 0). */
function ratioAtLeastPow10(a: bigint, b: bigint, exp: number): boolean {
  return exp >= 0 ? a >= b * 10n ** BigInt(exp) : a * 10n ** BigInt(-exp) >= b;
}

/**
 * The exact rational num/den rounded half away from zero to `sd` significant
 * digits. Deliberately a different construction from ratioToBigDecimal: the
 * leading exponent is estimated from BIT lengths and walked into place.
 */
function exactSig(num: bigint, den: bigint, sd = 40): BigDecimal {
  if (den === 0n) throw new Error("exactSig: den = 0");
  if (num === 0n) return new BigDecimal(0);
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  let e = Math.floor(
    (a.toString(16).length - b.toString(16).length) * 4 * Math.LOG10E * Math.LN2
  );
  while (!ratioAtLeastPow10(a, b, e)) e--;
  while (ratioAtLeastPow10(a, b, e + 1)) e++;
  const k = sd - 1 - e;
  const n = k >= 0 ? a * 10n ** BigInt(k) : a;
  const d = k >= 0 ? b : b * 10n ** BigInt(-k);
  const q = n / d;
  const rounded = 2n * (n % d) >= d ? q + 1n : q;
  return new BigDecimal(`${negative ? "-" : ""}${rounded}e${-k}`);
}

/** floor(sqrt(n)) by Newton's method. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Deterministic PRNG (mulberry32) so the sweeps are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBigInt(next: () => number, maxBits: number): bigint {
  const bits = 1 + Math.floor(next() * maxBits);
  let x = 0n;
  for (let i = 0; i < bits; i += 16) x = (x << 16n) | BigInt(Math.floor(next() * 65536));
  return x & ((1n << BigInt(bits)) - 1n);
}

/** |x/y - 1|, for approximate sanity checks only. */
function relErr(x: BigDecimal, y: BigDecimal): number {
  return Math.abs(x.div(y).minus(1).toNumber());
}

// ---------------------------------------------------------------------------
// ratioToBigDecimal
// ---------------------------------------------------------------------------

describe("ratioToBigDecimal — exact rational, 40 significant digits", () => {
  it("rounds repeating decimals half-up at the 40th significant digit", () => {
    expect(ratioToBigDecimal(1n, 3n).toFixed()).toBe("0." + "3".repeat(40));
    expect(ratioToBigDecimal(2n, 3n).toFixed()).toBe("0." + "6".repeat(39) + "7");
    expect(ratioToBigDecimal(-2n, 3n).toFixed()).toBe("-0." + "6".repeat(39) + "7");
    expect(ratioToBigDecimal(2n, -3n).toFixed()).toBe("-0." + "6".repeat(39) + "7");
    expect(ratioToBigDecimal(-2n, -3n).toFixed()).toBe("0." + "6".repeat(39) + "7");
    expect(ratioToBigDecimal(22n, 7n).eq(exactSig(22n, 7n))).toBe(true);
  });

  it("keeps RELATIVE precision at any magnitude (no 20-dp floor)", () => {
    // 1/3 · 10^-60: the old `.div` would have returned 0.
    const tiny = ratioToBigDecimal(1n, 3n * 10n ** 60n);
    expect(tiny.toString()).toBe("3." + "3".repeat(39) + "e-61");
    expect(tiny.sd()).toBe(40);
    const huge = ratioToBigDecimal(10n ** 80n, 3n);
    expect(huge.toPrecision(40)).toBe("3." + "3".repeat(39) + "e+79");
  });

  it("is exact when the value has <= 40 significant digits", () => {
    expect(ratioToBigDecimal(1n, 1024n).toFixed()).toBe("0.0009765625");
    expect(ratioToBigDecimal(10n ** 50n, 1n).eq(new BigDecimal("1e50"))).toBe(true);
    expect(ratioToBigDecimal(123456789n, 1000n).toFixed()).toBe("123456.789");
  });

  it("rounds half away from zero (bignumber ROUND_HALF_UP), sign-aware, with carry", () => {
    expect(ratioToBigDecimal(25n, 10n, 1).toFixed()).toBe("3");
    expect(ratioToBigDecimal(-25n, 10n, 1).toFixed()).toBe("-3");
    expect(ratioToBigDecimal(24n, 10n, 1).toFixed()).toBe("2");
    expect(ratioToBigDecimal(35n, 1000n, 1).toFixed()).toBe("0.04");
    expect(ratioToBigDecimal(9995n, 1000n, 3).toFixed()).toBe("10");
    expect(ratioToBigDecimal(-9995n, 1000n, 3).toFixed()).toBe("-10");
    expect(ratioToBigDecimal(15n, 1n, 1).toFixed()).toBe("20");
    // 40-digit boundary: 1e45 + 5 rounds to 1e45, 1e40 + 5 to 1.000…001e40.
    expect(ratioToBigDecimal(10n ** 45n + 5n, 1n).eq(new BigDecimal("1e45"))).toBe(true);
    expect(ratioToBigDecimal(10n ** 40n + 5n, 1n).toFixed()).toBe("1" + "0".repeat(38) + "10");
  });

  it("returns 0 for a zero numerator and (like safeDiv) a zero denominator", () => {
    expect(ratioToBigDecimal(0n, 7n).isZero()).toBe(true);
    expect(ratioToBigDecimal(0n, -7n).isZero()).toBe(true);
    expect(ratioToBigDecimal(7n, 0n).isZero()).toBe(true);
  });

  it("rejects a non-positive or fractional digit count", () => {
    expect(() => ratioToBigDecimal(1n, 3n, 0)).toThrow(RangeError);
    expect(() => ratioToBigDecimal(1n, 3n, 1.5)).toThrow(RangeError);
  });

  it("matches the independent reference over 2,000 random rationals", () => {
    const next = rng(0xdec1);
    for (let i = 0; i < 2000; i++) {
      let num = randomBigInt(next, 400);
      let den = randomBigInt(next, 400) || 1n;
      if (next() < 0.5) num = -num;
      if (next() < 0.5) den = -den;
      const sd = next() < 0.8 ? 40 : 1 + Math.floor(next() * 60);
      const got = ratioToBigDecimal(num, den, sd);
      const want = exactSig(num, den, sd);
      if (!got.eq(want)) {
        throw new Error(`${num}/${den} @${sd}: got ${got.toString()}, want ${want.toString()}`);
      }
      expect(got.sd()).toBeLessThanOrEqual(sd);
    }
  });
});

// ---------------------------------------------------------------------------
// sqrtPriceX96ToTokenPrices
// ---------------------------------------------------------------------------

const NATIVE = new NativeTokenDetails("ETH", "Ether", 18n);

function token(id: string, decimals: bigint): Token {
  return { id, decimals } as unknown as Token;
}

/** [token0Price, token1Price] computed independently from the exact rational. */
function expectedPrices(sqrtP: bigint, dec0: bigint, dec1: bigint): [BigDecimal, BigDecimal] {
  const num = sqrtP * sqrtP * 10n ** dec0;
  const den = Q192 * 10n ** dec1;
  return [exactSig(den, num), exactSig(num, den)];
}

/** sqrtPriceX96 for a target token1Price = priceNum / priceDen (token1 per token0). */
function sqrtPriceFor(priceNum: bigint, priceDen: bigint, dec0: bigint, dec1: bigint): bigint {
  return isqrt((priceNum * 10n ** dec1 * Q192) / (priceDen * 10n ** dec0));
}

/** The pre-fix body of sqrtPriceX96ToTokenPrices, verbatim in effect. */
function legacyPrices(sqrtP: bigint, dec0: bigint, dec1: bigint): [BigDecimal, BigDecimal] {
  const price1 = new BigDecimal((sqrtP * sqrtP).toString())
    .div(new BigDecimal(Q192.toString()))
    .times(exponentToBigDecimal(dec0))
    .div(exponentToBigDecimal(dec1));
  const price0 = price1.isZero() ? new BigDecimal(0) : new BigDecimal(1).div(price1);
  return [price0, price1];
}

function pricesFor(sqrtP: bigint, dec0: bigint, dec1: bigint) {
  return sqrtPriceX96ToTokenPrices(
    sqrtP,
    token("1_0x000000000000000000000000000000000000000a", dec0),
    token("1_0x000000000000000000000000000000000000000b", dec1),
    NATIVE
  );
}

function expectExact(sqrtP: bigint, dec0: bigint, dec1: bigint) {
  const [p0, p1] = pricesFor(sqrtP, dec0, dec1);
  const [e0, e1] = expectedPrices(sqrtP, dec0, dec1);
  expect(p0.toString()).toBe(e0.toString());
  expect(p1.toString()).toBe(e1.toString());
  expect(p0.eq(e0) && p1.eq(e1)).toBe(true);
  return [p0, p1] as const;
}

describe("sqrtPriceX96ToTokenPrices — exact rational, 40 significant digits", () => {
  it("cheap 18-decimal token vs 6-decimal USDC (NAVI/USDC shape, ~1.8465e-6)", () => {
    const sqrtP = sqrtPriceFor(18465n, 10n ** 10n, 18n, 6n);
    const [p0, p1] = expectExact(sqrtP, 18n, 6n);
    expect(relErr(p1, new BigDecimal("1.8465e-6"))).toBeLessThan(1e-15);
    expect(relErr(p0.times(p1), new BigDecimal(1))).toBeLessThan(1e-38);
    // Old code: sqrtP²/2^192 ≈ 1.8465e-18 kept 3 digits at 20 dp -> 1.85e-6.
    const [, legacy1] = legacyPrices(sqrtP, 18n, 6n);
    expect(legacy1.toString()).toBe("0.00000185");
    expect(relErr(legacy1, p1)).toBeGreaterThan(1e-3);
  });

  it("27-decimal token vs 6-decimal USDC (ctUSDe shape, ~0.88) is no longer 0", () => {
    const sqrtP = sqrtPriceFor(88n, 100n, 27n, 6n);
    const [p0, p1] = expectExact(sqrtP, 27n, 6n);
    expect(p1.isZero()).toBe(false);
    expect(relErr(p1, new BigDecimal("0.88"))).toBeLessThan(1e-15);
    expect(relErr(p0, new BigDecimal(1).div("0.88"))).toBeLessThan(1e-15);
    // Old code: the raw ratio 8.8e-22 rounded to 0 at 20 dp, so BOTH prices were 0.
    const [legacy0, legacy1] = legacyPrices(sqrtP, 27n, 6n);
    expect(legacy0.isZero() && legacy1.isZero()).toBe(true);
  });

  it("18/18 pool with an extremely cheap token1: token0Price ≈ 1e-29 is non-zero", () => {
    const sqrtP = sqrtPriceFor(10n ** 29n, 1n, 18n, 18n);
    const [p0, p1] = expectExact(sqrtP, 18n, 18n);
    expect(p0.isZero()).toBe(false);
    expect(relErr(p0, new BigDecimal("1e-29"))).toBeLessThan(1e-12);
    expect(relErr(p1, new BigDecimal("1e29"))).toBeLessThan(1e-12);
    // Old code: token0Price = 1/1e29 at 20 dp = 0.
    expect(legacyPrices(sqrtP, 18n, 18n)[0].isZero()).toBe(true);
  });

  it("MIN_SQRT_RATIO (18/18): both prices exact, neither 0", () => {
    const [p0, p1] = expectExact(MIN_SQRT_RATIO, 18n, 18n);
    expect(p1.toPrecision(5)).toBe("2.9390e-39");
    expect(p0.toPrecision(5)).toBe("3.4026e+38");
    const [legacy0, legacy1] = legacyPrices(MIN_SQRT_RATIO, 18n, 18n);
    expect(legacy0.isZero() && legacy1.isZero()).toBe(true);
  });

  it("MAX_SQRT_RATIO (18/18): both prices exact, neither 0", () => {
    const [p0, p1] = expectExact(MAX_SQRT_RATIO, 18n, 18n);
    expect(p0.toPrecision(5)).toBe("2.9390e-39");
    expect(p1.toPrecision(5)).toBe("3.4026e+38");
    // Old code: token0Price = 1/3.4e38 at 20 dp = 0.
    expect(legacyPrices(MAX_SQRT_RATIO, 18n, 18n)[0].isZero()).toBe(true);
  });

  it("sqrtP = 2^96 (raw price 1) with decimals 18/6: exactly 1e12 / 1e-12", () => {
    const [p0, p1] = expectExact(2n ** 96n, 18n, 6n);
    expect(p1.toFixed()).toBe("1000000000000");
    expect(p0.toFixed()).toBe("0.000000000001");
  });

  it("normal ETH/USDC (~3500), native ETH decimals taken from nativeTokenDetails", () => {
    const sqrtP = sqrtPriceFor(3500n, 1n, 18n, 6n);
    // token0 is native ETH: its stored decimals are deliberately wrong to prove
    // the ADDRESS_ZERO branch reads nativeTokenDetails.decimals (18) instead.
    const [p0, p1] = sqrtPriceX96ToTokenPrices(
      sqrtP,
      token(ADDRESS_ZERO, 0n),
      token("1_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6n),
      NATIVE
    );
    const [e0, e1] = expectedPrices(sqrtP, 18n, 6n);
    expect(p0.eq(e0) && p1.eq(e1)).toBe(true);
    expect(relErr(p1, new BigDecimal(3500))).toBeLessThan(1e-15);
    expect(p1.sd()).toBe(40);
  });

  it("sqrtP = 0 gives [0, 0]", () => {
    const [p0, p1] = pricesFor(0n, 18n, 6n);
    expect(p0.isZero() && p1.isZero()).toBe(true);
  });

  it("token0Price is the exact reciprocal rational, not 1 / rounded token1Price", () => {
    const next = rng(0x5eed);
    let differs = 0;
    for (let i = 0; i < 200; i++) {
      const sqrtP = MIN_SQRT_RATIO + (randomBigInt(next, 160) % (MAX_SQRT_RATIO - MIN_SQRT_RATIO));
      const [p0, p1] = pricesFor(sqrtP, 18n, 18n);
      expect(p0.eq(expectedPrices(sqrtP, 18n, 18n)[0])).toBe(true);
      // Exact rational of the STORED (rounded) token1Price, then its reciprocal.
      const [int, frac = ""] = p1.toFixed().split(".");
      const reciprocalOfRounded = exactSig(10n ** BigInt(frac.length), BigInt(int! + frac));
      if (!reciprocalOfRounded.eq(p0)) differs++;
    }
    // Inverting the rounded price would be off at the 40th digit this often.
    expect(differs).toBeGreaterThan(0);
  });

  it("matches the exact rational over 500 random (sqrtP, decimals) pairs", () => {
    const next = rng(0xa11ce);
    const DECIMALS = [0n, 2n, 6n, 8n, 9n, 12n, 18n, 24n, 27n, 36n];
    for (let i = 0; i < 500; i++) {
      const sqrtP = MIN_SQRT_RATIO + randomBigInt(next, 160) % (MAX_SQRT_RATIO - MIN_SQRT_RATIO);
      const dec0 = DECIMALS[Math.floor(next() * DECIMALS.length)]!;
      const dec1 = DECIMALS[Math.floor(next() * DECIMALS.length)]!;
      const [p0, p1] = pricesFor(sqrtP, dec0, dec1);
      const [e0, e1] = expectedPrices(sqrtP, dec0, dec1);
      if (!p0.eq(e0) || !p1.eq(e1)) {
        throw new Error(`sqrtP=${sqrtP} dec=${dec0}/${dec1}: got ${p0}/${p1}, want ${e0}/${e1}`);
      }
      expect(p0.isZero() || p1.isZero()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tick prices
// ---------------------------------------------------------------------------

/** 1.0001^n as the exact rational 10001^n / 10000^n (memoised per |n|). */
const exactPowCache = new Map<number, [bigint, bigint]>();
function exactTickPrice(tick: number): BigDecimal {
  const n = Math.abs(tick);
  let pair = exactPowCache.get(n);
  if (!pair) {
    pair = [10001n ** BigInt(n), 10n ** BigInt(4 * n)];
    exactPowCache.set(n, pair);
  }
  const [up, down] = pair;
  return tick >= 0 ? exactSig(up, down) : exactSig(down, up);
}

function expectExactTick(tick: number) {
  const [p0, p1] = tickToPrices(tick);
  const e0 = exactTickPrice(tick);
  const e1 = exactTickPrice(-tick);
  if (!p0.eq(e0) || !p1.eq(e1)) {
    throw new Error(`tick ${tick}: got ${p0}/${p1}, want ${e0}/${e1}`);
  }
  expect(p0.isZero() || p1.isZero()).toBe(false);
  return [p0, p1] as const;
}

describe("tick prices — 1.0001^±tick, 40 significant digits, every tick", () => {
  it("tick 0 and ±1 are exact", () => {
    const [p0, p1] = expectExactTick(0);
    expect(p0.toFixed() + "/" + p1.toFixed()).toBe("1/1");
    expect(expectExactTick(1)[0].toFixed()).toBe("1.0001");
    expect(expectExactTick(-1)[1].toFixed()).toBe("1.0001");
    // 1/1.0001 = 0.99990000999900009999… rounded at the 40th digit.
    expect(expectExactTick(-1)[0].toFixed()).toBe(exactSig(10000n, 10001n).toFixed());
  });

  it("MIN_TICK / MAX_TICK (±887272) are exact and non-zero", { timeout: 60_000 }, () => {
    const [lo0, lo1] = expectExactTick(MIN_TICK);
    const [hi0, hi1] = expectExactTick(MAX_TICK);
    expect(lo0.toPrecision(5)).toBe("2.9390e-39");
    expect(lo1.toPrecision(5)).toBe("3.4026e+38");
    expect(hi0.eq(lo1) && hi1.eq(lo0)).toBe(true);
  });

  it("±421519 — where the old 18-dp prices hit 0 — are exact and non-zero", { timeout: 60_000 }, () => {
    const [n0, n1] = expectExactTick(-421519);
    const [p0, p1] = expectExactTick(421519);
    // 4.9497e-19: the old 20-dp-then-18-dp double rounding sent it to 0, and
    // price1 = safeDiv(1, 0) with it.
    expect(n0.toPrecision(5)).toBe("4.9497e-19");
    expect(p1.eq(n0) && p0.eq(n1)).toBe(true);
  });

  it("-230270 is exactly 1.00000220319197…e-10", () => {
    const [p0, p1] = expectExactTick(-230270);
    expect(p0.toString()).toBe("1.000002203191973486882842416434349309046e-10");
    expect(p1.toPrecision(15)).toBe("9999977968.12881");
  });

  // The exact 10001^n references dominate the run time here, not the code under
  // test; the budget is raised so a busy parallel run cannot flake it.
  it("is exact over 200 random ticks with |tick| <= 60000 and every tick in [-25, 25]", { timeout: 30_000 }, () => {
    const next = rng(0x71c4);
    for (let t = -25; t <= 25; t++) expectExactTick(t);
    for (let i = 0; i < 200; i++) expectExactTick(Math.floor(next() * 120001) - 60000);
  });

  it("is exact at the full-range ticks of common tickSpacings", { timeout: 60_000 }, () => {
    for (const t of [887270, -887220, 887200]) expectExactTick(t);
  });

  it("price0 · price1 = 1 within 1e-38 relative over a 12,000-tick sweep", () => {
    // Also runs the memo cache past its 10,000-entry bound (eviction path).
    const tolerance = new BigDecimal("1e-38");
    for (let t = MIN_TICK; t <= MAX_TICK; t += 148) {
      const [p0, p1] = tickToPrices(t);
      const err = p0.times(p1).minus(1).abs();
      if (err.gt(tolerance)) throw new Error(`tick ${t}: |p0·p1 - 1| = ${err}`);
      if (p0.sd() > 40 || p1.sd() > 40) throw new Error(`tick ${t}: > 40 significant digits`);
    }
  });

  it("memoises: a repeated tick returns the same instances", () => {
    const a = tickToPrices(123457);
    const b = tickToPrices(123457);
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
  });

  it("createInitialTick stores exactly tickToPrices' values", () => {
    const tick = createInitialTick("1_pool_-421519", -421519, "1_pool", 1n, 2n, 1n);
    const [p0, p1] = tickToPrices(-421519);
    expect(tick.price0.eq(p0) && tick.price1.eq(p1)).toBe(true);
    expect(tick.tickIdx).toBe(-421519n);
    expect(tick.liquidityGross).toBe(0n);
    expect(tick.liquidityNet).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// convertTokenToDecimal
// ---------------------------------------------------------------------------

/** The pre-fix body: `.div` by 10^decimals, which rounds to 20 dp. */
function legacyConvert(amount: bigint, decimals: bigint): BigDecimal {
  if (decimals === 0n) return new BigDecimal(amount.toString());
  return new BigDecimal(amount.toString()).div(exponentToBigDecimal(decimals));
}

describe("convertTokenToDecimal — exact shiftedBy instead of a 20-dp .div", () => {
  const AMOUNTS = [
    0n, 1n, -1n, 999999n, 1000000n, 123456789n, -987654321987654321n,
    10n ** 18n, 1234567890123456789012345678901234567890n,
    2n ** 255n - 1n, -(2n ** 127n),
  ];

  for (const decimals of [0n, 6n, 18n]) {
    it(`decimals ${decimals}: byte-identical to the old .div result`, () => {
      for (const amount of AMOUNTS) {
        const got = convertTokenToDecimal(amount, decimals);
        const old = legacyConvert(amount, decimals);
        expect(got.toString()).toBe(old.toString());
        expect(got.toFixed()).toBe(old.toFixed());
        expect(got.eq(old)).toBe(true);
      }
    });
  }

  it("decimals 0..20: identical to the old result over 2,000 random amounts", () => {
    const next = rng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const decimals = BigInt(Math.floor(next() * 21));
      let amount = randomBigInt(next, 256);
      if (next() < 0.5) amount = -amount;
      const got = convertTokenToDecimal(amount, decimals);
      const old = legacyConvert(amount, decimals);
      if (got.toFixed() !== old.toFixed()) {
        throw new Error(`${amount} @${decimals}: got ${got.toFixed()}, old ${old.toFixed()}`);
      }
    }
  });

  it("decimals 27 (ctUSDe): now exact where the old code rounded to 20 dp", () => {
    const amount = 123456789012345678901234567891n;
    expect(convertTokenToDecimal(amount, 27n).toFixed()).toBe("123.456789012345678901234567891");
    expect(legacyConvert(amount, 27n).toFixed()).toBe("123.45678901234567890123");
    // One raw unit: 1e-27, which the old code stored as 0.
    expect(convertTokenToDecimal(1n, 27n).eq(new BigDecimal("1e-27"))).toBe(true);
    expect(legacyConvert(1n, 27n).isZero()).toBe(true);
  });
});
