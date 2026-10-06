import { BigDecimal } from "envio";
import { ZERO_BI } from "./constants";
import { ratioToBigDecimal } from "./index";

/*
 * TICK PRICES: price0 = 1.0001^tick, price1 = 1.0001^-tick, each to 40
 * significant digits, for every tick in [MIN_TICK, MAX_TICK] = [-887272, 887272]
 * (values span ~2.9e-39 … 3.4e38).
 *
 * The previous code ran `fastExponentiation` on BigDecimal — 40-dp steps, a
 * 20-dp `safeDiv` for negative ticks (bignumber's default DECIMAL_PLACES, see
 * `ratioToBigDecimal`) — then `toFixed(18)`, and took price1 as `toFixed(18)` of
 * a 20-dp 1/price0. Fixed decimal places destroy small values: every tick
 * <= -421,519 stored price0 = price1 = 0, every tick >= 421,519 stored
 * price1 = 0, and negative ticks kept only a handful of digits.
 *
 * NOW: 1.0001^|tick| is computed by exponentiation by squaring on a bigint
 * fixed-point accumulator with TICK_FP_DECIMALS = 100 decimal places, rounding
 * half-up after each product. Every intermediate is >= 1, so that is >= 100
 * significant digits of RELATIVE precision at every step; squaring at most
 * doubles a relative error, so after the <= 23 squarings an int24 tick can need
 * the accumulated error is below 2^24 · 0.5e-100 < 1e-92 — more than 50 digits
 * of headroom over the 40 we keep. The other side is the exact reciprocal of
 * that accumulator, taken as a rational by `ratioToBigDecimal` (no bignumber
 * `.div`, no `Math.pow`, no `.pow`). Pinned against exact 10001^n / 10000^n
 * rationals in test/precision.test.ts, including both extremes.
 */
const TICK_FP_DECIMALS = 100;
const TICK_FP_ONE = BigInt(10) ** BigInt(TICK_FP_DECIMALS);
const TICK_FP_HALF = TICK_FP_ONE / BigInt(2);

// TICK_FP_POW2[i] = 1.0001^(2^i) in fixed point, extended lazily by squaring.
// 20 entries cover |tick| <= 887272 < 2^20; int24 extremes add up to 4 more.
const TICK_FP_POW2: bigint[] = [BigInt(10001) * BigInt(10) ** BigInt(TICK_FP_DECIMALS - 4)];

function fixedMul(x: bigint, y: bigint): bigint {
  return (x * y + TICK_FP_HALF) / TICK_FP_ONE;
}

/** 1.0001^n · 10^TICK_FP_DECIMALS (rounded), for an integer n >= 0. */
function pow10001Fixed(n: number): bigint {
  let result = TICK_FP_ONE;
  for (let i = 0; n > 0; i++, n = Math.floor(n / 2)) {
    if (i === TICK_FP_POW2.length) {
      const prev = TICK_FP_POW2[i - 1]!;
      TICK_FP_POW2.push(fixedMul(prev, prev));
    }
    if (n % 2 === 1) result = fixedMul(result, TICK_FP_POW2[i]!);
  }
  return result;
}

/*
 * MEMOISED, bounded. A tick row is created once per (pool, tickIdx), but the
 * same tickIdx recurs across pools — the full-range ticks for each tickSpacing
 * above all — so a hit skips ~20 bigint products and two rational roundings.
 * `BigDecimal` is immutable, so sharing instances is safe. FIFO eviction keeps
 * memory flat over a long backfill.
 */
const TICK_PRICE_CACHE_MAX = 10_000;
const tickPriceCache = new Map<number, readonly [BigDecimal, BigDecimal]>();

/** [price0, price1] = [1.0001^tick, 1.0001^-tick], 40 significant digits each. */
export function tickToPrices(tickIdx: number): readonly [BigDecimal, BigDecimal] {
  const hit = tickPriceCache.get(tickIdx);
  if (hit !== undefined) return hit;

  const up = pow10001Fixed(Math.abs(tickIdx)); // 1.0001^|tick| · 10^100
  const large = ratioToBigDecimal(up, TICK_FP_ONE); // 1.0001^|tick|
  const small = ratioToBigDecimal(TICK_FP_ONE, up); // 1.0001^-|tick|
  const prices = tickIdx >= 0 ? ([large, small] as const) : ([small, large] as const);

  if (tickPriceCache.size >= TICK_PRICE_CACHE_MAX) {
    tickPriceCache.delete(tickPriceCache.keys().next().value!);
  }
  tickPriceCache.set(tickIdx, prices);
  return prices;
}

export function createInitialTick(
  tickId: string,
  tickIdx: number,
  poolId: string,
  timestamp: bigint,
  blockNumber: bigint,
  chainId: bigint
) {
  // 1.0001^tick is token1/token0: price0 = 1.0001^tick, price1 = 1.0001^-tick,
  // 40 significant digits each — see tickToPrices for why not 18 dp.
  const [price0, price1] = tickToPrices(tickIdx);

  const tick = {
    id: tickId,
    chainId,
    pool_id: poolId,
    tickIdx: BigInt(tickIdx),
    poolAddress: poolId,
    createdAtTimestamp: timestamp,
    createdAtBlockNumber: blockNumber,
    liquidityGross: ZERO_BI,
    liquidityNet: ZERO_BI,
    price0,
    price1,
  };

  return tick;
}
