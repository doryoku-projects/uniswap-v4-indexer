/*
 * Two small pieces of v4 fee arithmetic:
 *
 *  - BalanceDelta decoding, for reading `modifyLiquidity`'s `feesAccrued` return
 *    value out of a call trace. A port of the Ponder indexer's
 *    `core/balanceDelta.ts`.
 *  - The protocol-fee split of a Swap event's fee (below).
 *
 * The uncollected-fee math that used to live here is gone with the fee sweep:
 * uncollected fees are now computed by the Tickwise backend.
 *
 * Raw base units throughout. The consumer divides into decimals downstream.
 */

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

// ─── Protocol fee ────────────────────────────────────────────────────────────
//
// The `fee` on a v4 Swap event is the COMBINED swap fee, not the LP fee. In
// v4-core `Pool.swap` it is `swapFee = protocolFee == 0 ? lpFee :
// calculateSwapFee(protocolFee, lpFee)`, i.e. `p + l - p·l/1e6` for protocol fee
// `p` and LP fee `l`, and the protocol's cut is taken off the GROSS input first:
// `(amountIn + feeAmount) · p / 1e6`. So what the LPs actually earn is
// `grossInput · (swapFee - p) / 1e6`, and `swapFee - p` is the rate this indexer
// books as the swap's fee.
//
// `p` is not on the Swap event. It lives in the pool's Slot0 as a packed uint24,
// `ProtocolFees.setProtocolFee` emits `ProtocolFeeUpdated(id, protocolFee)` for
// every change, and a new pool starts at 0 with no event, so tracking that event
// (`Pool.protocolFee`) is a complete record. Everything is in hundredths of a bip.

const PROTOCOL_FEE_MASK = 0xfffn;

/**
 * The part of a packed `Pool.protocolFee` that applies to one swap direction,
 * as `ProtocolFeeLibrary` reads it: the LOW 12 bits for a zeroForOne swap, the
 * HIGH 12 bits for a oneForZero swap.
 */
export function protocolFeeForDirection(packed: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? packed & PROTOCOL_FEE_MASK : (packed >> 12n) & PROTOCOL_FEE_MASK;
}

/**
 * Is this swap zeroForOne (token0 in, token1 out)?
 *
 * A v4 Swap event reports `amount0`/`amount1` from the SWAPPER's side: negative
 * is what the swapper paid in, positive what they received (v4-core
 * `Pool.swap` builds the delta that way for both exact-in and exact-out, and
 * `PoolManager._swap` emits it unchanged). A zeroForOne swap therefore has
 * `amount0 < 0` and `amount1 > 0`. Note this is the OPPOSITE sign to the
 * `amount0`/`amount1` the swap handler books on the Swap entity, which it
 * negates to the pool's side.
 *
 * `amount1` only matters when `amount0` is 0, which no real swap has; a swap of
 * nothing has no fee to split either way.
 */
export function isZeroForOne(amount0: bigint, amount1: bigint): boolean {
  return amount0 < 0n || (amount0 === 0n && amount1 > 0n);
}

/**
 * The LP fee rate of a swap, in hundredths of a bip: the event's combined fee
 * minus the protocol fee of the swap's direction, floored at 0.
 *
 * With `packedProtocolFee` 0 (no protocol fee set, the usual case) this is the
 * event fee unchanged.
 */
export function lpFeeRate(
  swapFee: bigint,
  packedProtocolFee: bigint,
  zeroForOne: boolean,
): bigint {
  const lp = swapFee - protocolFeeForDirection(packedProtocolFee, zeroForOne);
  return lp > 0n ? lp : 0n;
}
