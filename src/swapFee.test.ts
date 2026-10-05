/**
 * A SWAP'S FEES ARE PRICED AT THAT SWAP'S OWN FEE — `event.params.fee`.
 *
 * `swap-handler.ts` used to price `feesUSD`, `feesETH`, `collectedFeesToken0/1`
 * and the HookStats fee with the STORED `pool.feeTier`, and only afterwards
 * overwrite `feeTier` with the event's fee. So each swap was charged the
 * PREVIOUS swap's rate — on a dynamic-fee pool, every swap; and the first swap
 * of a dynamic-fee pool was charged the Initialize value, the 0x800000 flag
 * (8,388,608 hundredths of a bip, i.e. ~8.39x the volume).
 *
 * Asserted through the pool's `collectedFeesToken0/1`, which are
 * `|amount| · fee / 1e6` with no price in them, so the test does not depend on
 * the pricing path. `feeTier` keeps its meaning: it still ends up as the most
 * recent swap's fee.
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

type PoolRow = {
  feeTier: bigint;
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

describe("swap fees use the swap's own event fee, not the stored feeTier", () => {
  it("stored feeTier 3000, event fee 500 → fees at 500; the next swap's 3000 → fees at 3000", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(STATIC_POOL, 3000n, 1)]);
    expect((await poolOf(ix, STATIC_POOL))!.feeTier).toBe(3000n);

    // 2 native in at 500 (0.05%); then 1 native out at 3000 (0.3%).
    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [
      swap(STATIC_POOL, 5, -2n * 10n ** 18n, 3000n * 10n ** 6n, 500n),
      swap(STATIC_POOL, 6, 10n ** 18n, -1500n * 10n ** 6n, 3000n),
    ]);

    const p = (await poolOf(ix, STATIC_POOL))!;
    // 2 · 0.0005 + 1 · 0.003. The old code charged each swap the previous
    // one's fee: 2 · 0.003 + 1 · 0.0005 = 0.0065.
    expect(p.collectedFeesToken0.toString()).toBe("0.004");
    // Token1 the same way, checked as a rate so it does not depend on how
    // token1's decimals resolved offline: (3000·0.0005 + 1500·0.003) / 4500.
    const rate1 = p.collectedFeesToken1.div(p.volumeToken1);
    expect(rate1.toString()).toBe(new BigDecimal(6).div(4500).toString());

    // feeTier keeps its meaning — the most recent swap's fee — and each Swap row
    // records its own.
    expect(p.feeTier).toBe(3000n);
    expect((await swapOf(ix, 5))!.fee).toBe(500n);
    expect((await swapOf(ix, 6))!.fee).toBe(3000n);
  }, 120_000);

  it("the first swap of a DYNAMIC-fee pool is not charged the 0x800000 flag", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(DYNAMIC_POOL, DYNAMIC_FEE_FLAG, 1)]);
    expect((await poolOf(ix, DYNAMIC_POOL))!.feeTier).toBe(DYNAMIC_FEE_FLAG);

    await run(ix, SWAP_BLOCK, SWAP_BLOCK, [swap(DYNAMIC_POOL, 5, -(10n ** 18n), 3000n * 10n ** 6n, 3000n)]);

    const p = (await poolOf(ix, DYNAMIC_POOL))!;
    // 1 · 0.003. Priced at the stored flag it was 1 · 8.388608.
    expect(p.collectedFeesToken0.toString()).toBe("0.003");
    expect(p.collectedFeesToken0.div(p.volumeToken0).toString()).toBe("0.003");
    expect(p.feeTier).toBe(3000n);
  }, 120_000);
});
