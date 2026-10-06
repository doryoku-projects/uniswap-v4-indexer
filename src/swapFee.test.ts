/**
 * A SWAP'S FEES ARE PRICED AT ITS LP FEE RATE — the event's fee minus the
 * protocol fee, and never the pool's stored `feeTier`.
 *
 * `swap-handler.ts` used to price `feesUSD`, `feesETH`, `collectedFeesToken0/1`
 * and the HookStats fee with the STORED `pool.feeTier`, and only afterwards
 * overwrite `feeTier` with the event's fee. So each swap was charged the
 * PREVIOUS swap's rate — on a dynamic-fee pool, every swap; and the first swap
 * of a dynamic-fee pool was charged the Initialize value, the 0x800000 flag
 * (8,388,608 hundredths of a bip, i.e. ~8.39x the volume).
 *
 * Pricing at the event fee fixed that, but the event fee is the COMBINED LP +
 * protocol fee, so a pool with a protocol fee set booked the protocol's share as
 * LP income. The handler now subtracts the protocol fee of the swap's direction
 * (`Pool.protocolFee`, kept by `protocolFee-handler.ts`), and `feeTier` is the
 * PoolKey fee and is never rewritten.
 *
 * Asserted through the pool's `collectedFeesToken0/1`, which are
 * `|amount| · lpFee / 1e6` with no price in them, so the test does not depend on
 * the pricing path. The pure arithmetic is in protocolFee.test.ts.
 *
 * Driven through the real handlers with `createTestIndexer`. No network:
 * `fetch` answers every JSON-RPC call with -32601, as in
 * positionReplayHeal.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const CHAIN = 1;
const POOL_MGR = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const STATIC_POOL = "0x5151515151515151515151515151515151515151515151515151515151515151";
const DYNAMIC_POOL = "0x6262626262626262626262626262626262626262626262626262626262626262";
const TRADER = "0x31E3E4c1ad0DC13f2D8c58C0b1fD9fD9Dd6bE1f5";
const MID_SQRT = 79228162514264337593543950336n; // tick 0
const DYNAMIC_FEE_FLAG = 0x800000n;

const INIT_BLOCK = 21900000;
const PROTOCOL_BLOCK = 21900005;
const SWAP_BLOCK = 21900010;

const initialize = (id: string, fee: bigint, logIndex: number) => ({
  contract: "PoolManager",
  event: "Initialize",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: INIT_BLOCK, timestamp: 1740000000 },
  params: {
    id,
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fee,
    tickSpacing: 60n,
    hooks: "0x0000000000000000000000000000000000000000",
    sqrtPriceX96: MID_SQRT,
    tick: 0n,
  },
});

const swap = (id: string, logIndex: number, amount0: bigint, amount1: bigint, fee: bigint) => ({
  contract: "PoolManager",
  event: "Swap",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: SWAP_BLOCK, timestamp: 1740000120 },
  transaction: { hash: "0x5a" + logIndex.toString(16).padStart(62, "0"), from: TRADER },
  params: {
    id,
    sender: TRADER,
    amount0,
    amount1,
    sqrtPriceX96: MID_SQRT,
    liquidity: 10n ** 18n,
    tick: 0n,
    fee,
  },
});

const protocolFeeUpdated = (id: string, protocolFee: bigint, logIndex: number, block = PROTOCOL_BLOCK) => ({
  contract: "PoolManager",
  event: "ProtocolFeeUpdated",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: block, timestamp: 1740000060 },
  params: { id, protocolFee },
});

/** Pack per-direction protocol fees the way `Slot0` does: oneForZero in the high 12 bits. */
const packProtocolFee = (zeroForOne: bigint, oneForZero: bigint) => (oneForZero << 12n) | zeroForOne;

type PoolRow = {
  feeTier: bigint;
  protocolFee: bigint;
  volumeToken0: BigDecimal;
  volumeToken1: BigDecimal;
  collectedFeesToken0: BigDecimal;
  collectedFeesToken1: BigDecimal;
};

const run = (ix: ReturnType<typeof createTestIndexer>, startBlock: number, endBlock: number, simulate: unknown[]) =>
  ix.process({ chains: { [CHAIN]: { startBlock, endBlock, simulate } } } as never);

const poolOf = (ix: ReturnType<typeof createTestIndexer>, id: string) =>
  (ix as unknown as { Pool: { get: (id: string) => Promise<PoolRow | undefined> } }).Pool.get(`${CHAIN}_${id}`);

const swapOf = (ix: ReturnType<typeof createTestIndexer>, logIndex: number) =>
  (ix as unknown as { Swap: { get: (id: string) => Promise<{ fee: bigint } | undefined> } }).Swap.get(
    `${CHAIN}_${SWAP_BLOCK}_${logIndex}`,
  );

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "the method does not exist" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

describe("swap fees use the swap's own fee, not the stored feeTier", () => {
  it("stored feeTier 3000, event fee 500 → fees at 500; the next swap's 3000 → fees at 3000", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 3000n, 1)]);
    expect((await poolOf(ix, STATIC_POOL))!.feeTier).toBe(3000n);

    // 1 native out at 3000 (0.3%); then 2 native in at 500 (0.05%).
    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [
      swap(STATIC_POOL, 5, 10n ** 18n, -1500n * 10n ** 6n, 3000n),
      swap(STATIC_POOL, 6, -2n * 10n ** 18n, 3000n * 10n ** 6n, 500n),
    ]);

    const p = (await poolOf(ix, STATIC_POOL))!;
    // 1 · 0.003 + 2 · 0.0005. The old code charged each swap the previous
    // one's fee: 1 · 0.003 + 2 · 0.003 = 0.009.
    expect(p.collectedFeesToken0.toString()).toBe("0.004");
    // Token1 the same way, checked as a rate so it does not depend on how
    // token1's decimals resolved offline: (1500·0.003 + 3000·0.0005) / 4500.
    const rate1 = p.collectedFeesToken1.div(p.volumeToken1);
    expect(rate1.toString()).toBe(new BigDecimal(6).div(4500).toString());

    // feeTier is the PoolKey fee. The last swap paid 500 and it is still 3000;
    // each Swap row records the fee it paid.
    expect(p.feeTier).toBe(3000n);
    expect((await swapOf(ix, 5))!.fee).toBe(3000n);
    expect((await swapOf(ix, 6))!.fee).toBe(500n);
  }, 120_000);

  it("the first swap of a DYNAMIC-fee pool is not charged the 0x800000 flag, and the flag stays", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(DYNAMIC_POOL, DYNAMIC_FEE_FLAG, 1)]);
    expect((await poolOf(ix, DYNAMIC_POOL))!.feeTier).toBe(DYNAMIC_FEE_FLAG);

    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [swap(DYNAMIC_POOL, 5, -(10n ** 18n), 3000n * 10n ** 6n, 3000n)]);

    const p = (await poolOf(ix, DYNAMIC_POOL))!;
    // 1 · 0.003. Priced at the stored flag it was 1 · 8.388608.
    expect(p.collectedFeesToken0.toString()).toBe("0.003");
    expect(p.collectedFeesToken0.div(p.volumeToken0).toString()).toBe("0.003");
    // The flag is how a consumer tells a dynamic-fee pool apart. A swap used to
    // overwrite it with that swap's fee (3000), which made the pool look static.
    expect(p.feeTier).toBe(DYNAMIC_FEE_FLAG);
    expect((await swapOf(ix, 5))!.fee).toBe(3000n);
  }, 120_000);
});

describe("the protocol fee is taken out of the swap fee before LP fees are booked", () => {
  it("a new pool has protocolFee 0, and ProtocolFeeUpdated sets and replaces it", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 500n, 1)]);
    expect((await poolOf(ix, STATIC_POOL))!.protocolFee).toBe(0n);

    const first = packProtocolFee(125n, 250n);
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [protocolFeeUpdated(STATIC_POOL, first, 1)]);
    expect((await poolOf(ix, STATIC_POOL))!.protocolFee).toBe(first);

    // The latest event wins, including back to 0.
    await run(ix, PROTOCOL_BLOCK + 1, PROTOCOL_BLOCK + 1, [
      protocolFeeUpdated(STATIC_POOL, packProtocolFee(1000n, 1000n), 2, PROTOCOL_BLOCK + 1),
      protocolFeeUpdated(STATIC_POOL, 0n, 3, PROTOCOL_BLOCK + 1),
    ]);
    const p = (await poolOf(ix, STATIC_POOL))!;
    expect(p.protocolFee).toBe(0n);
    // And it never touches the PoolKey fee.
    expect(p.feeTier).toBe(500n);
  }, 120_000);

  it("ProtocolFeeUpdated for a pool that was never initialized creates nothing", async () => {
    const ix = createTestIndexer();
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [protocolFeeUpdated(STATIC_POOL, 125n, 1)]);
    expect(await poolOf(ix, STATIC_POOL)).toBeUndefined();
  }, 120_000);

  it("static pool, key fee 500, protocol fee 125 each way: event fee 625 books LP fee 500, in both directions", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 500n, 1)]);
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [
      protocolFeeUpdated(STATIC_POOL, packProtocolFee(125n, 125n), 1),
    ]);

    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [
      // zeroForOne: swapper pays 2 native.
      swap(STATIC_POOL, 5, -2n * 10n ** 18n, 3000n * 10n ** 6n, 625n),
      // oneForZero: swapper receives 1 native.
      swap(STATIC_POOL, 6, 10n ** 18n, -1500n * 10n ** 6n, 625n),
    ]);

    const p = (await poolOf(ix, STATIC_POOL))!;
    // 2 · 0.0005 + 1 · 0.0005. Booking the event fee would give 3 · 0.000625.
    expect(p.collectedFeesToken0.toString()).toBe("0.0015");
    expect(p.feeTier).toBe(500n);
    // The Swap row keeps the raw combined fee.
    expect((await swapOf(ix, 5))!.fee).toBe(625n);
  }, 120_000);

  it("an asymmetric protocol fee subtracts the LOW 12 bits for zeroForOne and the HIGH 12 bits for oneForZero", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 3000n, 1)]);
    // zeroForOne 100, oneForZero 300. With LP fee 3000 the combined fee is
    // 100 + 3000 - floor(100·3000/1e6) = 3100 one way and
    // 300 + 3000 - floor(300·3000/1e6) = 3300 the other.
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [
      protocolFeeUpdated(STATIC_POOL, packProtocolFee(100n, 300n), 1),
    ]);

    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [
      // zeroForOne, 1 native in: 3100 - 100 = 3000. Read the other way round it
      // would be 3100 - 300 = 2800.
      swap(STATIC_POOL, 5, -(10n ** 18n), 1500n * 10n ** 6n, 3100n),
      // oneForZero, 2 native out: 3300 - 300 = 3000. Read the other way round
      // it would be 3300 - 100 = 3200.
      swap(STATIC_POOL, 6, 2n * 10n ** 18n, -3000n * 10n ** 6n, 3300n),
    ]);

    // 1 · 0.003 + 2 · 0.003. The amounts differ so that two swapped halves
    // (1 · 0.0028 + 2 · 0.0032 = 0.0092) cannot sum to the same figure.
    expect((await poolOf(ix, STATIC_POOL))!.collectedFeesToken0.toString()).toBe("0.009");
  }, 120_000);

  it("dynamic-fee pool: LP fee 2000 with protocol fee 1000 emits 2998, books 1998, and keeps the flag", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(DYNAMIC_POOL, DYNAMIC_FEE_FLAG, 1)]);
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [
      protocolFeeUpdated(DYNAMIC_POOL, packProtocolFee(1000n, 1000n), 1),
    ]);

    // 1000 + 2000 - floor(1000·2000/1e6) = 2998, and the protocol takes 1000 of
    // the gross input, leaving the LPs 1998.
    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [swap(DYNAMIC_POOL, 5, -(10n ** 18n), 3000n * 10n ** 6n, 2998n)]);

    const p = (await poolOf(ix, DYNAMIC_POOL))!;
    expect(p.collectedFeesToken0.toString()).toBe("0.001998");
    expect(p.feeTier).toBe(DYNAMIC_FEE_FLAG);
  }, 120_000);

  it("protocolFee 0 means the event fee is used unchanged", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 3000n, 1)]);
    // Set, then cleared again before any swap.
    await run(ix, PROTOCOL_BLOCK, PROTOCOL_BLOCK, [
      protocolFeeUpdated(STATIC_POOL, packProtocolFee(500n, 500n), 1),
      protocolFeeUpdated(STATIC_POOL, 0n, 2),
    ]);

    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [swap(STATIC_POOL, 5, -(10n ** 18n), 3000n * 10n ** 6n, 3000n)]);
    expect((await poolOf(ix, STATIC_POOL))!.collectedFeesToken0.toString()).toBe("0.003");
  }, 120_000);
});
