/*
 * Position fee math — the exact arithmetic Uniswap v4 uses, ported so collected
 * fees can be derived WITHOUT debug_traceTransaction.
 *
 * The contract (v4-core Position.update) does, in unchecked arithmetic:
 *
 *   feesOwed = mulDiv(feeGrowthInside - feeGrowthInsideLast, liquidityBefore, 2^128)
 *   feeGrowthInsideLast = feeGrowthInside
 *
 * `liquidityBefore` is read BEFORE the delta is applied, so a position whose
 * stored liquidity is 0 always owes 0 — that is what makes a fresh mint safe.
 *
 * Because the contract overwrites `feeGrowthInsideLast` with the value it just
 * used, ONE eth_call of StateView.getPositionInfo after the block returns that
 * exact value. So `collectedFees(fgNew, fgPrev, liquidityBefore)` reproduces
 * `feesAccrued` bit for bit, with no trace and no debug namespace.
 *
 * Same-block repeats need no special case. If a tokenId is modified twice in
 * one block, both events read the same end-of-block baseline, so the second
 * event's delta is 0 and it books no fee — which is exactly right whenever no
 * swap or donate interleaved between them. Measured on Robinhood over 150k
 * blocks: 2,179 same-block repeats, of which only 1 had an interleaved swap AND
 * a nonzero leading liquidityDelta, the sole shape that can shift a total.
 */
import { TickMath } from "./liquidityMath/tickMath";

export const Q128 = 340282366920938463463374607431768211456n; // 2^128
const MASK256 = (1n << 256n) - 1n;
const HALF256 = 1n << 255n;

/**
 * uint256 wrapping subtraction — the contract's `unchecked { a - b }`.
 * Fee-growth accumulators are allowed to wrap, and the subtraction relies on it.
 */
export function wrapSub(a: bigint, b: bigint): bigint {
  return (a - b) & MASK256;
}

/** Absolute value of a bigint. */
export const absBig = (v: bigint): bigint => (v < 0n ? -v : v);

/** salt == bytes32(tokenId), big-endian — v4's position-salt encoding. */
export function saltOf(tokenId: bigint): `0x${string}` {
  return `0x${tokenId.toString(16).padStart(64, "0")}`;
}

/** Raw base units -> human-readable number (what the consumer reads). */
export function toHuman(raw: bigint, decimals: number | bigint): number {
  if (raw === 0n) return 0;
  return Number(raw) / 10 ** Number(decimals);
}

/**
 * Degenerate-pool guard. A pool pinned at the tick/price extreme yields
 * physically impossible amounts; such positions are flagged `isPriceable=false`
 * and their amounts zeroed rather than recorded. This is the corruption fix the
 * Ponder indexer exists for — do not weaken it.
 */
export function isDegenerate(tick: bigint, sqrtPriceX96: bigint): boolean {
  return (
    tick >= TickMath.MAX_TICK ||
    tick <= TickMath.MIN_TICK ||
    sqrtPriceX96 >= TickMath.MAX_SQRT_RATIO ||
    sqrtPriceX96 <= TickMath.MIN_SQRT_RATIO
  );
}

export interface FeeAmounts {
  amount0: bigint;
  amount1: bigint;
}

/**
 * Exact collected fee for one ModifyLiquidity, in raw base units.
 *
 * @param fgNew0/1          feeGrowthInsideLast AFTER the event (from getPositionInfo)
 * @param fgPrev0/1         the baseline we stored at the previous settle
 * @param liquidityBefore   position liquidity BEFORE this event's delta
 *
 * Returns zeroes when `liquidityBefore` is 0, mirroring the contract: a mint,
 * or a position we have no prior baseline for, owes nothing.
 *
 * A delta above 2^255 means the accumulator moved BACKWARDS, which cannot
 * happen across a genuine forward settle — it signals a stale or missing
 * baseline. Such a leg is dropped to 0 rather than multiplied out into the
 * ~2^256 artifact that the amounts corruption was made of.
 */
export function collectedFees(
  fgNew0: bigint,
  fgNew1: bigint,
  fgPrev0: bigint,
  fgPrev1: bigint,
  liquidityBefore: bigint,
): FeeAmounts {
  if (liquidityBefore <= 0n) return { amount0: 0n, amount1: 0n };

  const d0 = wrapSub(fgNew0, fgPrev0);
  const d1 = wrapSub(fgNew1, fgPrev1);

  return {
    amount0: d0 >= HALF256 ? 0n : (d0 * liquidityBefore) / Q128,
    amount1: d1 >= HALF256 ? 0n : (d1 * liquidityBefore) / Q128,
  };
}

/**
 * Uncollected (accrued but unsettled) fees, in raw base units. Port of
 * ponder/core/fees.ts, itself a port of the v4 subgraph's feeCalculation.
 *
 * Single guard: the negative-delta clamp. Off-chain we diff an already-composed
 * `feeGrowthInside` (StateView) against a stored baseline; a negative delta is
 * a stale or out-of-range read, NOT a real modular wrap, so wrapping it would
 * manufacture a ~2^256 fee. Clamp that leg to 0 instead.
 *
 * There is deliberately NO magnitude cap: token supply and decimals are
 * unbounded, so any ceiling silently drops legitimate large fees on cheap,
 * high-supply tokens (that was the original bug). The astronomical artifact is
 * prevented at the CALL SITE instead — only diff while the position is in
 * range, so the current read is a small in-range value and an out-of-range
 * baseline makes the delta negative, which clamps here.
 */
export function calculateUncollectedFees(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): FeeAmounts {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const rawDelta0 = feeGrowthInside0X128 - feeGrowthInside0LastX128;
  const rawDelta1 = feeGrowthInside1X128 - feeGrowthInside1LastX128;
  if (rawDelta0 < 0n && rawDelta1 < 0n) return { amount0: 0n, amount1: 0n };

  const delta0 = rawDelta0 < 0n ? 0n : rawDelta0;
  const delta1 = rawDelta1 < 0n ? 0n : rawDelta1;

  return {
    amount0: (delta0 * liquidity) / Q128,
    amount1: (delta1 * liquidity) / Q128,
  };
}

/** True when `tick` sits inside [tickLower, tickUpper) — v4's in-range test. */
export function isInRange(tick: bigint, tickLower: bigint, tickUpper: bigint): boolean {
  return tick >= tickLower && tick < tickUpper;
}
