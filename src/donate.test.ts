/**
 * A DONATION IS TOKENS ENTERING THE POOL — NOT A SWAP FEE.
 *
 * `PoolManager.donate` moves tokens from the caller into the pool and credits
 * them to the in-range LPs as fee growth, so a pool whose own LP fee is 0% can
 * still pay its LPs. The event used to be subscribed to and dropped. These tests
 * pin what `donate-handler.ts` does with it:
 *
 *  - the tokens raise `totalValueLocked*` (they are in the pool) and the pool's
 *    own `donatedToken0/1`;
 *  - they do NOT become swap fees: `feesUSD` and `collectedFees*` stay what the
 *    LP fee rate made them, so a 0% pool still reports 0% fees;
 *  - `txCount` is not bumped;
 *  - a re-delivered Donate (envio re-applies a committed range without reverting
 *    it) is recognised by its `Donation` row and not applied twice.
 *
 * Driven through the real handlers with `createTestIndexer`. No network: `fetch`
 * answers every JSON-RPC call with -32601, as in swapFee.test.ts. Token0 is the
 * native token and the donations are token0-only, so no decimals have to be
 * resolved over RPC.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const CHAIN = 1;
const POOL_MGR = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const ZERO_FEE_POOL = "0x7171717171717171717171717171717171717171717171717171717171717171";
const UNKNOWN_POOL = "0x8282828282828282828282828282828282828282828282828282828282828282";
const DONOR = "0x31E3E4c1ad0DC13f2D8c58C0b1fD9fD9Dd6bE1f5";
const MID_SQRT = 79228162514264337593543950336n; // tick 0

const INIT_BLOCK = 21900000;
const DONATE_BLOCK = 21900010;

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

const donate = (id: string, logIndex: number, amount0: bigint, amount1: bigint, block = DONATE_BLOCK) => ({
  contract: "PoolManager",
  event: "Donate",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: block, timestamp: 1740000120 },
  transaction: { hash: "0x6d" + logIndex.toString(16).padStart(62, "0"), from: DONOR },
  params: { id, sender: DONOR, amount0, amount1 },
});

type PoolRow = {
  txCount: bigint;
  feesUSD: BigDecimal;
  collectedFeesToken0: BigDecimal;
  collectedFeesToken1: BigDecimal;
  totalValueLockedToken0: BigDecimal;
  totalValueLockedToken1: BigDecimal;
  donatedToken0: BigDecimal;
  donatedToken1: BigDecimal;
  donatedUSD: BigDecimal;
};
type DonationRow = {
  pool: string;
  sender: string;
  transaction: string;
  amount0: BigDecimal;
  amount1: BigDecimal;
};

const run = (ix: ReturnType<typeof createTestIndexer>, startBlock: number, endBlock: number, simulate: unknown[]) =>
  ix.process({ chains: { [CHAIN]: { startBlock, endBlock, simulate } } } as never);

const poolOf = (ix: ReturnType<typeof createTestIndexer>, id: string) =>
  (ix as unknown as { Pool: { get: (id: string) => Promise<PoolRow | undefined> } }).Pool.get(`${CHAIN}_${id}`);

const donationOf = (ix: ReturnType<typeof createTestIndexer>, logIndex: number, block = DONATE_BLOCK) =>
  (ix as unknown as { Donation: { get: (id: string) => Promise<DonationRow | undefined> } }).Donation.get(
    `${CHAIN}_${block}_${logIndex}`,
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

describe("a donation raises TVL and the pool's donated totals, and books no swap fees", () => {
  it("2 native donated to a 0% pool: TVL and donated0 are 2, fees and txCount are untouched", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(ZERO_FEE_POOL, 0n, 1)]);
    const before = (await poolOf(ix, ZERO_FEE_POOL))!;
    expect(before.donatedToken0.toString()).toBe("0");
    expect(before.totalValueLockedToken0.toString()).toBe("0");

    await run(ix, DONATE_BLOCK, DONATE_BLOCK, [donate(ZERO_FEE_POOL, 7, 2n * 10n ** 18n, 0n)]);

    const p = (await poolOf(ix, ZERO_FEE_POOL))!;
    expect(p.totalValueLockedToken0.toString()).toBe("2");
    expect(p.totalValueLockedToken1.toString()).toBe("0");
    expect(p.donatedToken0.toString()).toBe("2");
    expect(p.donatedToken1.toString()).toBe("0");

    // The pool's LP fee is 0%, and a donation is not a fee on a swap.
    expect(p.feesUSD.toString()).toBe("0");
    expect(p.collectedFeesToken0.toString()).toBe("0");
    expect(p.collectedFeesToken1.toString()).toBe("0");
    expect(p.txCount).toBe(before.txCount);

    const d = (await donationOf(ix, 7))!;
    expect(d.pool).toBe(`${CHAIN}_${ZERO_FEE_POOL}`);
    expect(d.sender).toBe(DONOR);
    expect(d.transaction).toBe("0x6d" + "7".padStart(62, "0"));
    expect(d.amount0.toString()).toBe("2");
    expect(d.amount1.toString()).toBe("0");
  }, 120_000);

  it("donations accumulate across events", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(ZERO_FEE_POOL, 0n, 1)]);
    await run(ix, DONATE_BLOCK, DONATE_BLOCK, [
      donate(ZERO_FEE_POOL, 3, 2n * 10n ** 18n, 0n),
      donate(ZERO_FEE_POOL, 4, 5n * 10n ** 17n, 0n),
    ]);

    const p = (await poolOf(ix, ZERO_FEE_POOL))!;
    expect(p.totalValueLockedToken0.toString()).toBe("2.5");
    expect(p.donatedToken0.toString()).toBe("2.5");
    expect((await donationOf(ix, 3))!.amount0.toString()).toBe("2");
    expect((await donationOf(ix, 4))!.amount0.toString()).toBe("0.5");
  }, 120_000);
});

describe("a Donate that cannot be applied", () => {
  it("is skipped when its Donation row already exists (replay guard)", async () => {
    const ix = createTestIndexer();
    await run(ix, INIT_BLOCK, INIT_BLOCK, [initialize(ZERO_FEE_POOL, 0n, 1)]);

    // A committed range being re-delivered leaves this row behind. Seeded
    // directly because `createTestIndexer` refuses to rewind (`startBlock must
    // be greater than previously processed endBlock`), the same reason
    // positionReplayHeal.test.ts seeds its ledger rows.
    (ix as unknown as { Donation: { set: (row: unknown) => void } }).Donation.set({
      id: `${CHAIN}_${DONATE_BLOCK}_7`,
      chainId: BigInt(CHAIN),
      transaction: "0x6d" + "7".padStart(62, "0"),
      timestamp: 1740000120n,
      pool: `${CHAIN}_${ZERO_FEE_POOL}`,
      sender: DONOR,
      origin: DONOR,
      amount0: new BigDecimal("2"),
      amount1: new BigDecimal("0"),
      amountUSD: new BigDecimal("0"),
      logIndex: 7n,
    });

    await run(ix, DONATE_BLOCK, DONATE_BLOCK, [donate(ZERO_FEE_POOL, 7, 2n * 10n ** 18n, 0n)]);

    // The seeded row stands for an application that already happened to a pool
    // row we did not seed, so the pool must be exactly as Initialize left it.
    // Applied a second time, these would be 2.
    const p = (await poolOf(ix, ZERO_FEE_POOL))!;
    expect(p.totalValueLockedToken0.toString()).toBe("0");
    expect(p.donatedToken0.toString()).toBe("0");
  }, 120_000);

  it("creates nothing for a pool that was never initialized", async () => {
    const ix = createTestIndexer();
    await run(ix, DONATE_BLOCK, DONATE_BLOCK, [donate(UNKNOWN_POOL, 1, 10n ** 18n, 0n)]);

    expect(await poolOf(ix, UNKNOWN_POOL)).toBeUndefined();
    expect(await donationOf(ix, 1)).toBeUndefined();
  }, 120_000);
});
