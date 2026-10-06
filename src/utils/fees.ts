/*
 * BalanceDelta decoding, for reading `modifyLiquidity`'s `feesAccrued` return
 * value out of a call trace. A port of the Ponder indexer's
 * `core/balanceDelta.ts`.
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
