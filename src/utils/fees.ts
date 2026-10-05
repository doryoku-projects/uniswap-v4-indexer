/*
 * Uncollected-fee math and BalanceDelta decoding.
 *
 * Originally a near-verbatim port of the Ponder indexer's `core/fees.ts` and
 * `core/balanceDelta.ts`, on the principle that the port should change the
 * runtime and not the numbers. The uncollected-fee formula NO LONGER follows
 * that principle: both indexers shipped the same clamp, the clamp was wrong
 * against the chain, and both now compute the contract's own modular formula
 * (Ponder: `core/fees.ts`, fixed first and verified there; see
 * `calculateUncollectedFees` below for the evidence). BalanceDelta decoding is
 * unchanged.
 *
 * Raw base units throughout. The consumer divides into decimals downstream.
 */

/** 2^128, the fee-growth fixed-point scale. */
export const Q128 = 1n << 128n;

export interface UncollectedFees {
  amount0: bigint;
  amount1: bigint;
}

/**
 * `n mod 2^256` — the EVM's unchecked uint256 wrap, exact for ANY bigint.
 *
 * USED, and load-bearing. An earlier version kept this "for reference" and
 * clamped negative deltas instead, on the theory that a negative off-chain
 * delta is a stale read rather than a real wrap. For a delta against the
 * contract's own checkpoint that theory is false — see below. (`BigInt.asUintN`
 * also replaces the old `n + 2^256`, which was only correct for -2^256 <= n.)
 */
export function toUint256(n: bigint): bigint {
  return BigInt.asUintN(256, n);
}

/**
 * uncollected = toUint256(feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128,
 * per token, floor division — EXACTLY what the contract will pay out.
 *
 * THE CONTRACT'S OWN MATH. v4 `Position.update` computes
 *
 *     feesOwed = FullMath.mulDiv(feeGrowthInsideX128 - feeGrowthInsideLastX128, liquidity, Q128)
 *
 * inside an `unchecked` block, so the subtraction wraps mod 2^256.
 * `feeGrowthInside` is itself a wrapping quantity — `Pool.getFeeGrowthInside`
 * composes global and per-tick outside growth with unchecked subtraction, so for
 * an OUT-OF-RANGE position it routinely reads near 2^256 — and the checkpoint
 * `feeGrowthInsideLast` lives in the same ring. Their difference mod 2^256 is
 * therefore the true growth since the checkpoint, in range or out, and a raw
 * difference that looks NEGATIVE is an ordinary positive amount mod 2^256.
 *
 * THE CLAMP THIS REPLACES was wrong, not conservative. It zeroed any leg whose
 * raw difference was negative — which is the ordinary out-of-range reading —
 * and the sweep compounded it by writing 0/0 for every out-of-range position
 * without reading it. Verified against chain: out-of-range positions with
 * claimable fees (mainnet tokenIds 10014 and 100022 among them) were served as
 * 0. The Ponder port's identical fix matches on-chain StateView math on
 * 1,000/1,000 + 144/144 positions across Arbitrum / mainnet / Optimism windows.
 *
 * CALLER CONTRACT — `last` MUST be the contract's checkpoint, i.e. StateView
 * `getPositionInfo(...).feeGrowthInside{0,1}LastX128`, read at the SAME block
 * as `getFeeGrowthInside`. The modular difference is exact only within one ring
 * against the checkpoint the contract itself will settle against. An
 * indexer-side baseline — the Position row's `feeGrowthInside*LastX128`, which
 * `modifyLiquidity-handler` stamps from a POOL-level end-of-block read, or a
 * `newPosition()` 0 — is NOT that checkpoint, and diffing against it mod 2^256
 * can manufacture a ~2^256 fee. The sweep (`utils/feeSweep.ts`) honours this:
 * both values come from one `getPositionFeeGrowthBatch` multicall at one block.
 *
 * There is intentionally NO magnitude cap. Token supply and decimals are
 * unbounded, so any ceiling silently drops legitimate large fees on cheap
 * high-supply tokens — which was the original bug in this logic. Decimals are
 * not parameters for the same reason: there is nothing to scale against.
 *
 * `liquidity <= 0n` → 0/0. Liquidity is a uint128 on-chain; a non-positive
 * value only arrives from a clamped or stale row, and accrues nothing.
 */
export function calculateUncollectedFees(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): UncollectedFees {
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };

  const delta0 = toUint256(feeGrowthInside0X128 - feeGrowthInside0LastX128);
  const delta1 = toUint256(feeGrowthInside1X128 - feeGrowthInside1LastX128);

  return {
    amount0: (delta0 * liquidity) / Q128,
    amount1: (delta1 * liquidity) / Q128,
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
