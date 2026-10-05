import { BigDecimal } from "envio";
import { ZERO_BD } from "./constants";

/*
 * MEMOISED. The body builds a string in a loop and parses it, and it used to be
 * called four times per Swap event (sqrtPriceX96ToTokenPrices and
 * convertTokenToDecimal) — for one of only ~19 distinct inputs (the decimals of
 * the tokens actually indexed). Caching turns a string build into a Map hit.
 * `BigDecimal` is bignumber.js and immutable, so sharing an instance across
 * callers is safe.
 *
 * NO LONGER ON THE PRICING PATH: dividing by this rounds to 20 dp, which is the
 * precision bug `ratioToBigDecimal` / `shiftedBy` replaced. Multiplying by it is
 * exact; dividing by it is not — prefer `shiftedBy(-decimals)`.
 */
const exponentCache = new Map<bigint, BigDecimal>();

export function exponentToBigDecimal(decimals: bigint): BigDecimal {
  const hit = exponentCache.get(decimals);
  if (hit !== undefined) return hit;

  let resultString = "1";

  for (let i = 0; i < Number(decimals); i++) {
    resultString += "0";
  }

  const result = new BigDecimal(resultString);
  exponentCache.set(decimals, result);
  return result;
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.eq(ZERO_BD)) {
    return ZERO_BD;
  } else {
    return amount0.div(amount1);
  }
}

// Cap BigDecimal precision at 40 decimal places. Postgres btree indexes have a
// hard 2704-byte-per-row limit, so an unbounded BigDecimal (e.g. from a runaway
// derivedETH on a manipulated oracle pool) can fail INSERTs on indexed numeric
// columns. Apply at indexed-column writes and at price-source values that
// propagate downstream (derivedETH, ethPriceUSD).
const BD_MAX_DP = 40;

export function sanitizeBD(value: BigDecimal): BigDecimal {
  /*
   * FAST PATH, and it is the hot one. This runs 37 times per Swap event — 6 in
   * the handler, 31 across the five interval-update helpers — and the previous
   * body (`new BigDecimal(value.toFixed(40))`) formatted a 40-decimal STRING and
   * reparsed it every single time. Envio measured the cost rising with sync
   * progress for exactly that reason: as `volumeUSD`/`feesUSD`/`totalValueLocked`
   * grow from hundreds to billions the strings lengthen, so both the format and
   * the reparse get dearer. Swap went 221µs -> 303-367µs over five hours.
   *
   * Values already within 40 dp — the overwhelming majority — now return
   * UNCHANGED, with no string and no allocation. `BigDecimal` is bignumber.js
   * and immutable, so handing back the same instance is safe.
   *
   * ROUNDING MODE IS DELIBERATELY UNSPECIFIED so it inherits the same default as
   * `toFixed(40)` did. Passing an explicit mode (`ROUND_DOWN`, say) would
   * TRUNCATE where this rounds, silently changing stored values. Pinned by the
   * parity test in `sanitizeBD.test.ts`.
   */
  const dp = value.decimalPlaces();
  return dp !== null && dp <= BD_MAX_DP ? value : value.decimalPlaces(BD_MAX_DP);
}

export function hexToBigInt(hex: string): bigint {
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }
  return BigInt(`0x${hex}`);
}

/*
 * MEMOISED 10^n as a bigint. `ratioToBigDecimal` scales by one of these on
 * every call (twice per Swap via sqrtPriceX96ToTokenPrices), and the exponents
 * that occur are few — they follow the decimals of the indexed tokens and the
 * magnitude of the price — so a Map hit replaces a bigint exponentiation.
 */
const pow10Cache = new Map<number, bigint>();

function pow10(n: number): bigint {
  const hit = pow10Cache.get(n);
  if (hit !== undefined) return hit;
  const result = BigInt(10) ** BigInt(n);
  pow10Cache.set(n, result);
  return result;
}

/**
 * The EXACT rational `num / den`, rounded ROUND_HALF_UP to `significantDigits`
 * significant digits (default 40).
 *
 * WHY THIS EXISTS. `BigDecimal` is bignumber.js on its default config —
 * DECIMAL_PLACES = 20, ROUND_HALF_UP — so every `.div` rounds to 20 FIXED
 * decimal places. That is harmless for a USD total and fatal for a price: a
 * quotient below 1e-20 becomes exactly 0, and one just above it keeps a digit
 * or two. Routing `sqrtPriceX96² / 2^192` and `1.0001^tick` through `.div`
 * zeroed the prices of 430 active pools on mainnet (cheap tokens, and tokens
 * with far more decimals than their pair, e.g. 18 vs 6 or 27 vs 6) and skewed
 * others (NAVI/USDC by 0.19%) — and those prices feed derivedETH, hence every
 * USD figure, plus the Pool/Tick/interval price columns.
 *
 * HOW. Everything is bigint arithmetic, so the quotient is exact until the
 * single final rounding; the rounded digits are built as a bigint and placed
 * with `shiftedBy`, which is exact too. The value NEVER passes through a
 * bignumber `.div`. Precision is RELATIVE — 40 significant digits whether the
 * price is 3e38 or 3e-39 — rather than a fixed number of decimal places.
 *
 * Rounding is on the magnitude with the sign applied afterwards, i.e. half away
 * from zero: exactly bignumber's ROUND_HALF_UP. `num == 0` gives 0, and so does
 * `den == 0` (mirroring `safeDiv`, so a degenerate input zeroes a price instead
 * of throwing inside a handler).
 */
export function ratioToBigDecimal(
  num: bigint,
  den: bigint,
  significantDigits = 40
): BigDecimal {
  if (!Number.isInteger(significantDigits) || significantDigits < 1) {
    throw new RangeError(
      `ratioToBigDecimal: significantDigits must be a positive integer, got ${significantDigits}`
    );
  }
  if (num === BigInt(0) || den === BigInt(0)) return ZERO_BD;

  const negative = num < BigInt(0) !== den < BigInt(0);
  const a = num < BigInt(0) ? -num : num;
  const b = den < BigInt(0) ? -den : den;

  // e = floor(log10(a / b)), the decimal exponent of the leading digit. With
  // la/lb the digit counts, a/b lies in (10^(la-lb-1), 10^(la-lb+1)), so e is
  // la-lb or one less; a single exact comparison decides which.
  let e = a.toString().length - b.toString().length;
  if (e >= 0 ? a < b * pow10(e) : a * pow10(-e) < b) e -= 1;

  // Scale so the integer quotient has exactly `significantDigits` digits:
  // value = q * 10^-k with 10^(sd-1) <= q < 10^sd before rounding.
  const k = significantDigits - 1 - e;
  const n = k >= 0 ? a * pow10(k) : a;
  const d = k >= 0 ? b : b * pow10(-k);
  let q = n / d;
  // ROUND_HALF_UP on the magnitude. A carry (9.99…5 -> 10.00…) just yields
  // 10^sd, which is still the correctly rounded value.
  if ((n - q * d) * BigInt(2) >= d) q += BigInt(1);

  return new BigDecimal((negative ? "-" : "") + q.toString()).shiftedBy(-k);
}

const NULL_ETH_HEX_STRING =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export function isNullEthValue(value: string): boolean {
  return value == NULL_ETH_HEX_STRING;
}

/*
 * Raw token units -> human units, EXACTLY.
 *
 * This used to be `.div(exponentToBigDecimal(decimals))`, and bignumber's `.div`
 * rounds to 20 decimal places (see `ratioToBigDecimal`), so a token with more
 * than 20 decimals (27-decimal ctUSDe, for one) lost its low digits — and an
 * amount below 1e-20 tokens became 0. `shiftedBy(-decimals)` moves the decimal
 * point without rounding. For decimals <= 20 the quotient always fit in 20 dp,
 * so results there are identical to the old ones (pinned in
 * test/precision.test.ts); decimals 0 needs no special case.
 */
export function convertTokenToDecimal(
  tokenAmount: bigint,
  exchangeDecimals: bigint
): BigDecimal {
  return new BigDecimal(tokenAmount.toString()).shiftedBy(
    -Number(exchangeDecimals)
  );
}
