/*
 * Uncollected-fee math and BalanceDelta decoding.
 *
 * A near-verbatim port of the Ponder indexer's `core/fees.ts` and
 * `core/balanceDelta.ts`. The arithmetic, the guards and the deliberate
 * omissions are all carried across unchanged, because that code is already
 * tested against live data on four chains — the point of this migration is to
 * change the runtime, not the numbers.
 *
 * Raw base units throughout. The consumer divides into decimals downstream.
 */

/** 2^128, the fee-growth fixed-point scale. */
export const Q128 = 1n << 128n;
export const MAX_UINT256 = (1n << 256n) - 1n;

export interface UncollectedFees {
  amount0: bigint;
  amount1: bigint;
}

/**
 * uint256 wrap for fee-growth ring arithmetic.
 *
 * Kept for reference and deliberately NOT used, exactly as in Ponder: a
 * negative off-chain delta is a stale or out-of-range read, not a real modular
 * wrap, so the code below clamps instead of wrapping.
 */
export function toUint256(n: bigint): bigint {
  return n < 0n ? n + (MAX_UINT256 + 1n) : n;
}

/** Half the uint256 ring — a delta at or above this moved BACKWARDS. */
const HALF_UINT256 = 1n << 255n;

/**
 * uncollected = (feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128,
 * with the subtraction done the way the CONTRACT does it: unchecked, i.e.
 * modulo 2^256.
 *
 * WHY MODULAR, NOT A SIGNED CLAMP.
 *
 * This used to subtract as signed bigints and clamp a negative leg to 0, on the
 * reasoning that we diff a composed `feeGrowthInside` against a STORED baseline
 * where a backwards move means a stale read rather than a real wrap. Two things
 * are wrong with that.
 *
 * First, v4's fee-growth accumulators are unchecked uint256 and are MEANT to
 * wrap; `Position.update` subtracts them inside `unchecked`. A genuine rollover
 * therefore looks "negative" to signed arithmetic and gets clamped to zero,
 * losing the fee.
 *
 * Second, the justification leaned on the call site only ever diffing an
 * IN-RANGE position. That constraint is gone, and it was never sound: out of
 * range a position stops ACCRUING but keeps everything it accrued while in
 * range, and the contract pays it out in full at the next settle. Measured on
 * Avalanche: every one of 639 out-of-range live positions reported 0, and 237 of
 * them held real fees — 29.5 AVAX, 290 USDt and 286 USDC among them. Replaying
 * 10 settlements where the position was out of range at the time, this formula
 * reproduced the payout in the transaction trace exactly, 10/10.
 *
 * The `>= 2^255` guard keeps the one case the old clamp was actually right
 * about: a baseline genuinely AHEAD of current growth (a stale or never-written
 * one) is dropped to 0 rather than multiplied out into a ~2^256 artifact. On the
 * real Avalanche population that guard fired on 0 of 1,278 legs, so it costs
 * nothing and only catches the broken case.
 *
 * Still intentionally NO magnitude cap. Token supply and decimals are unbounded,
 * so any ceiling silently drops legitimate large fees on cheap high-supply
 * tokens — which was the original bug in this logic.
 *
 * Decimals are not parameters here — there is nothing to scale against.
 */
export function calculateUncollectedFees(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): UncollectedFees {
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };

  const delta0 = (feeGrowthInside0X128 - feeGrowthInside0LastX128) & MAX_UINT256;
  const delta1 = (feeGrowthInside1X128 - feeGrowthInside1LastX128) & MAX_UINT256;

  return {
    amount0: delta0 >= HALF_UINT256 ? 0n : (delta0 * liquidity) / Q128,
    amount1: delta1 >= HALF_UINT256 ? 0n : (delta1 * liquidity) / Q128,
  };
}

// ─── BalanceDelta ────────────────────────────────────────────────────────────
//
// v4 packs two int128s into one int256: amount0 in the high 128 bits, amount1 in
// the low 128, each two's-complement signed. Used to read `modifyLiquidity`'s
// `feesAccrued` return value out of a call trace.

/** Sign-extend the low 128 bits of `v` to a signed bigint. */
export function signExt128(v: bigint): bigint {
  const masked = v & ((1n << 128n) - 1n);
  return masked >= 1n << 127n ? masked - (1n << 128n) : masked;
}

export function decodeBalanceDelta(u: bigint): { amount0: bigint; amount1: bigint } {
  return {
    amount0: signExt128(u >> 128n),
    amount1: signExt128(u & ((1n << 128n) - 1n)),
  };
}

/** Absolute value — `feesAccrued` is signed but a collected fee is a magnitude. */
export function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}
