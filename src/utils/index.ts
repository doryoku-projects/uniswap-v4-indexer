import { BigDecimal } from "envio";
import { ZERO_BD, ONE_BD, ZERO_BI } from "./constants";

/*
 * MEMOISED. The body builds a string in a loop and parses it, and the pricing
 * path calls it four times per Swap event — for one of only ~19 distinct inputs
 * (the decimals of the tokens actually indexed). Caching turns a per-event
 * string build into a Map hit. `BigDecimal` is bignumber.js and immutable, so
 * sharing an instance across callers is safe.
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

/**
 * Implements exponentiation by squaring
 * (see https://en.wikipedia.org/wiki/Exponentiation_by_squaring )
 * to minimize the number of BigDecimal operations and their impact on performance.
 *
 * Uses Math.floor for correct integer division and caps intermediate precision
 * at 40 digits to prevent BigDecimal digit explosion during squaring steps
 * (without capping, 18 squaring levels would produce ~1M digit intermediates).
 */
export function fastExponentiation(
  value: BigDecimal,
  power: number
): BigDecimal {
  if (power < 0) {
    const result = fastExponentiation(value, -power);
    return safeDiv(ONE_BD, result);
  }

  if (power == 0) {
    return ONE_BD;
  }

  if (power == 1) {
    return value;
  }

  const halfPower = Math.floor(power / 2);
  const halfResult = fastExponentiation(value, halfPower);

  // Use the fact that x ^ (2n) = (x ^ n) * (x ^ n) and we can compute (x ^ n) only once.
  // Cap precision after each multiplication to prevent digit explosion.
  let result = new BigDecimal(halfResult.times(halfResult).toFixed(40));

  // For odd powers, x ^ (2n + 1) = (x ^ 2n) * x
  if (power % 2 == 1) {
    result = new BigDecimal(result.times(value).toFixed(40));
  }
  return result;
}

const NULL_ETH_HEX_STRING =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export function isNullEthValue(value: string): boolean {
  return value == NULL_ETH_HEX_STRING;
}

export function convertTokenToDecimal(
  tokenAmount: bigint,
  exchangeDecimals: bigint
): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return new BigDecimal(tokenAmount.toString());
  }
  return new BigDecimal(tokenAmount.toString()).div(
    exponentToBigDecimal(exchangeDecimals)
  );
}
