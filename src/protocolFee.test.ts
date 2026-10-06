/**
 * The pure arithmetic behind the protocol-fee split of a Swap event's fee
 * (utils/fees.ts). The handler-level behaviour is in swapFee.test.ts.
 *
 * The expected numbers are v4-core's, not this repo's: `ProtocolFeeLibrary`
 * packs the zeroForOne protocol fee in the low 12 bits and the oneForZero one
 * in the high 12 bits of a uint24, and `calculateSwapFee(p, l)` is
 * `p + l - floor(p·l / 1e6)`.
 */
import { describe, it, expect } from "vitest";
import { isZeroForOne, lpFeeRate, protocolFeeForDirection } from "./utils/fees";

/** v4-core's `ProtocolFeeLibrary.calculateSwapFee`, for generating realistic event fees. */
const calculateSwapFee = (p: bigint, lpFee: bigint) => p + lpFee - (p * lpFee) / 1_000_000n;

describe("protocolFeeForDirection", () => {
  it("reads the LOW 12 bits for zeroForOne and the HIGH 12 bits for oneForZero", () => {
    // oneForZero 0xABC (2748), zeroForOne 0x123 (291): 0xABC123.
    // (Not valid protocol fees — the max is 1000 — but they make every bit of
    // each half distinguishable, which is the point of this test.)
    const packed = 0xabc123n;
    expect(protocolFeeForDirection(packed, true)).toBe(0x123n);
    expect(protocolFeeForDirection(packed, false)).toBe(0xabcn);
  });

  it("works when only one direction is set", () => {
    expect(protocolFeeForDirection(125n, true)).toBe(125n);
    expect(protocolFeeForDirection(125n, false)).toBe(0n);
    expect(protocolFeeForDirection(125n << 12n, true)).toBe(0n);
    expect(protocolFeeForDirection(125n << 12n, false)).toBe(125n);
  });

  it("the max protocol fee, 1000 each way", () => {
    const packed = (1000n << 12n) | 1000n;
    expect(packed).toBe(0x3e83e8n);
    expect(protocolFeeForDirection(packed, true)).toBe(1000n);
    expect(protocolFeeForDirection(packed, false)).toBe(1000n);
  });

  it("0 is 0 in both directions", () => {
    expect(protocolFeeForDirection(0n, true)).toBe(0n);
    expect(protocolFeeForDirection(0n, false)).toBe(0n);
  });
});

describe("isZeroForOne", () => {
  // Swap event amounts are the SWAPPER's side: negative is what they paid in.
  it("token0 in (amount0 < 0, amount1 > 0) is zeroForOne", () => {
    expect(isZeroForOne(-1000n, 2000n)).toBe(true);
  });

  it("token1 in (amount0 > 0, amount1 < 0) is oneForZero", () => {
    expect(isZeroForOne(1000n, -2000n)).toBe(false);
  });

  it("falls back to amount1 when amount0 is 0", () => {
    expect(isZeroForOne(0n, 5n)).toBe(true);
    expect(isZeroForOne(0n, -5n)).toBe(false);
    // A swap of nothing: nothing to split, and it must not throw.
    expect(isZeroForOne(0n, 0n)).toBe(false);
  });
});

describe("lpFeeRate", () => {
  const sym = (p: bigint) => (p << 12n) | p;

  it("protocol fee 0: the event fee, unchanged", () => {
    expect(lpFeeRate(3000n, 0n, true)).toBe(3000n);
    expect(lpFeeRate(3000n, 0n, false)).toBe(3000n);
    // The dynamic-fee flag is not special here either: it is only ever a
    // stored feeTier, never an event fee.
    expect(lpFeeRate(2998n, 0n, true)).toBe(2998n);
  });

  it("static pool, key fee 500, protocol fee 125 each way: event fee 625 → LP 500", () => {
    expect(calculateSwapFee(125n, 500n)).toBe(625n);
    expect(lpFeeRate(625n, sym(125n), true)).toBe(500n);
    expect(lpFeeRate(625n, sym(125n), false)).toBe(500n);
  });

  it("asymmetric protocol fee uses the swap's own direction", () => {
    const packed = (300n << 12n) | 100n; // zeroForOne 100, oneForZero 300
    expect(lpFeeRate(calculateSwapFee(100n, 3000n), packed, true)).toBe(3000n);
    expect(lpFeeRate(calculateSwapFee(300n, 3000n), packed, false)).toBe(3000n);
    // The wrong half would give 2800 / 3200.
    expect(lpFeeRate(3100n, packed, false)).toBe(2800n);
  });

  it("dynamic-fee pool at the maximum protocol fee: LP 2000 → event 2998 → LPs earn 1998 of the gross input", () => {
    expect(calculateSwapFee(1000n, 2000n)).toBe(2998n);
    expect(lpFeeRate(2998n, sym(1000n), true)).toBe(1998n);
  });

  it("never goes negative", () => {
    // v4 cannot emit a swap fee below its protocol fee; a hook-adjusted or
    // otherwise odd value must still not turn into negative fee income.
    expect(lpFeeRate(100n, sym(500n), true)).toBe(0n);
    expect(lpFeeRate(500n, sym(500n), true)).toBe(0n);
  });
});
