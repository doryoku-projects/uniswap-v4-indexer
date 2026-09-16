/*
 * THE REPLAY GUARD MUST NOT FREEZE A POSITION ROW AS A STUB.
 *
 * Measured on the live rebuild: 12 chain-8453 Position rows sat at
 * `poolId: ""`, `liquidity: 0`, `isActive: false` while their `ModifyLiquidity`
 * and `PositionTransaction` ledger rows were complete and correct — e.g.
 * `8453_4032`, mint Transfer at logIndex 236 and its ModifyLiquidity at 237 in
 * the same transaction, DEPOSIT row present with amount0 88799.999999999999999998.
 *
 * The mechanism, reproduced below: on a re-processed range the guard in
 * modifyLiquidity-handler returned ABOVE `Position.set`, so the only handler
 * still writing the row was the PositionManager `Transfer` handler — and its
 * write is `newPosition()` spread with an owner, i.e. the stub. It is permanent:
 * the fee sweep filters on `poolId !== ""` (feeSync-block.ts:292), so a stub is
 * never re-read from chain either.
 *
 * Three cases, and all three matter:
 *
 *   1. HEAL — the ledger row survived without the position row. Must rebuild.
 *   2. NO DOUBLE COUNT — a genuinely already-applied range must stay untouched.
 *      This is what the guard was added for and removing the `return` outright
 *      would break it.
 *   3. EVERY EVENT OF THE WINDOW — not just the first. The live episodes lost a
 *      whole block range, so `8453_2806`'s later withdraw was skipped too and
 *      its `updatedAtBlock` stayed at the mint block. A fix keyed on
 *      "is the row still a stub?" passes case 1 and fails this one.
 *
 * No network: `fetch` is stubbed to a JSON-RPC -32601 for the whole file, which
 * is the capability-gap path both effects degrade through
 * (`isTraceCapabilityError`, and `getFeeGrowthInside`'s `ok: false`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const CHAIN = 1;
const POOL_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const POOL_MGR = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const POS_MGR = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
const TOKEN_ID = 4032n;
const SALT = "0x" + TOKEN_ID.toString(16).padStart(64, "0");
const OWNER = "0x31E3E4c1ad0DC13f2D8c58C0b1fD9fD9Dd6bE1f5";
const TX = "0x5d98da3a9d00000000000000000000000000000000000000000000000000000d";
const TX2 = "0x5d98da3a9d00000000000000000000000000000000000000000000000000002e";
const PID = `${CHAIN}_${TOKEN_ID}`;

const INIT_BLOCK = 21700000;
const MINT_BLOCK = 21700001;
const SECOND_BLOCK = 21700005;
const MINT_LOG_INDEX = 237;
const SECOND_LOG_INDEX = 12;
const DELTA = 2760743263836633442467n;
const DELTA2 = 1000000000000000000n;

const txn = (hash: string) => ({
  hash,
  from: OWNER,
  gasUsed: 300000n,
  effectiveGasPrice: 1000000000n,
  l1Fee: 0n,
});

/** The pool the position lives in. Without it ModifyLiquidity returns early. */
const initialize = {
  contract: "PoolManager",
  event: "Initialize",
  srcAddress: POOL_MGR,
  logIndex: 1,
  block: { number: INIT_BLOCK, timestamp: 1738000000 },
  params: {
    id: POOL_ID,
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fee: 3000n,
    tickSpacing: 60n,
    hooks: "0x0000000000000000000000000000000000000000",
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0n,
  },
};

/** The mint: Transfer from the zero address, then the liquidity add. */
const mintTransfer = {
  contract: "PositionManager",
  event: "Transfer",
  srcAddress: POS_MGR,
  logIndex: 236,
  block: { number: MINT_BLOCK, timestamp: 1738000012 },
  transaction: { hash: TX, from: OWNER },
  params: {
    from: "0x0000000000000000000000000000000000000000",
    to: OWNER,
    id: TOKEN_ID,
  },
};

const modifyLiquidity = (
  blockNumber: number,
  timestamp: number,
  logIndex: number,
  hash: string,
  liquidityDelta: bigint,
) => ({
  contract: "PoolManager",
  event: "ModifyLiquidity",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: blockNumber, timestamp },
  transaction: txn(hash),
  params: {
    id: POOL_ID,
    sender: POS_MGR,
    tickLower: -60n,
    tickUpper: 60n,
    liquidityDelta,
    salt: SALT,
  },
});

const mintModify = modifyLiquidity(
  MINT_BLOCK,
  1738000012,
  MINT_LOG_INDEX,
  TX,
  DELTA,
);
const secondModify = modifyLiquidity(
  SECOND_BLOCK,
  1738000102,
  SECOND_LOG_INDEX,
  TX2,
  DELTA2,
);

/** The ledger row a prior, committed run of that event left behind. */
const ledgerRow = (
  blockTimestamp: number,
  logIndex: number,
  hash: string,
  amount: bigint,
) => ({
  id: `${CHAIN}_${hash}_${logIndex}`,
  chainId: BigInt(CHAIN),
  transaction: hash,
  timestamp: BigInt(blockTimestamp),
  pool_id: `${CHAIN}_${POOL_ID}`,
  token0_id: `${CHAIN}_0x0000000000000000000000000000000000000000`,
  token1_id: `${CHAIN}_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`,
  sender: POS_MGR,
  origin: OWNER,
  salt: SALT,
  amount,
  amount0: new BigDecimal("8.269406017330364631"),
  amount1: new BigDecimal("0"),
  amountUSD: new BigDecimal("0"),
  tickLower: -60n,
  tickUpper: 60n,
  logIndex: BigInt(logIndex),
});

const process = (
  ix: ReturnType<typeof createTestIndexer>,
  startBlock: number,
  endBlock: number,
  simulate: unknown[],
) =>
  ix.process({
    chains: { [CHAIN]: { startBlock, endBlock, simulate } },
  } as never);

const position = (ix: ReturnType<typeof createTestIndexer>) =>
  (ix as unknown as {
    Position: { get: (id: string) => Promise<Record<string, never> | undefined> };
  }).Position.get(PID) as Promise<
    | undefined
    | {
        poolId: string;
        tickLower: bigint;
        tickUpper: bigint;
        liquidity: bigint;
        isActive: boolean;
        owner: string;
        depositedToken0: BigDecimal;
        depositedToken1: BigDecimal;
        totalGasCostETH: BigDecimal;
        updatedAtBlock: bigint;
        lastModifyBlock: bigint;
        lastModifyLogIndex: bigint;
      }
  >;

const pool = (ix: ReturnType<typeof createTestIndexer>) =>
  (ix as unknown as {
    Pool: { get: (id: string) => Promise<{ liquidity: bigint; txCount: bigint } | undefined> };
  }).Pool.get(`${CHAIN}_${POOL_ID}`);

const seedLedger = (
  ix: ReturnType<typeof createTestIndexer>,
  row: ReturnType<typeof ledgerRow>,
) =>
  (ix as unknown as {
    ModifyLiquidity: { set: (row: ReturnType<typeof ledgerRow>) => void };
  }).ModifyLiquidity.set(row);

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  // Every RPC answers "method not found", the capability-gap path. Collected
  // fees degrade to 0 and fee growth to `ok: false` — neither is what this file
  // asserts, and it keeps the test offline and fast.
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "the method does not exist" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

describe("replayed ModifyLiquidity and the Position row", () => {
  it("rebuilds a position whose ModifyLiquidity write was lost but whose ledger row survived", async () => {
    const ix = createTestIndexer();
    await process(ix, INIT_BLOCK, INIT_BLOCK, [initialize]);

    // The exact live state: the ledger row of a prior committed run is there,
    // the Position row is not.
    seedLedger(ix, ledgerRow(1738000012, MINT_LOG_INDEX, TX, DELTA));
    expect(await position(ix)).toBeUndefined();

    await process(ix, MINT_BLOCK, MINT_BLOCK, [mintTransfer, mintModify]);

    const pos = await position(ix);
    expect(pos).toBeDefined();
    // Every column the stub had wrong, and the owner the Transfer handler owns.
    expect(pos!.poolId).toBe(POOL_ID);
    expect(pos!.tickLower).toBe(-60n);
    expect(pos!.tickUpper).toBe(60n);
    expect(pos!.liquidity).toBe(DELTA);
    expect(pos!.isActive).toBe(true);
    expect(pos!.owner).toBe(OWNER);
    expect(pos!.depositedToken0.gt(new BigDecimal("0"))).toBe(true);
    // And the row now records which event it contains.
    expect(pos!.lastModifyBlock).toBe(BigInt(MINT_BLOCK));
    expect(pos!.lastModifyLogIndex).toBe(BigInt(MINT_LOG_INDEX));
  }, 120_000);

  it("does not double count when a fully applied range is re-processed", async () => {
    // A test indexer refuses to walk a chain backwards, so the committed state
    // is built on one and replayed on a second: `applied` is a REAL healthy run
    // of this event, rows and watermark and all, not a hand-written fixture.
    const first = createTestIndexer();
    await process(first, INIT_BLOCK, INIT_BLOCK, [initialize]);
    await process(first, MINT_BLOCK, MINT_BLOCK, [mintTransfer, mintModify]);
    const applied = await position(first);
    expect(applied!.liquidity).toBe(DELTA);
    expect(applied!.lastModifyBlock).toBe(BigInt(MINT_BLOCK));

    const ix = createTestIndexer();
    await process(ix, INIT_BLOCK, INIT_BLOCK, [initialize]);
    seedLedger(ix, ledgerRow(1738000012, MINT_LOG_INDEX, TX, DELTA));
    (ix as unknown as { Position: { set: (p: unknown) => void } }).Position.set(
      applied,
    );
    const poolBefore = await pool(ix);

    // The 2026-09-16 incident: a committed range applied a second time.
    await process(ix, MINT_BLOCK, MINT_BLOCK, [mintTransfer, mintModify]);

    const after = await position(ix);
    // Position: the running sums are untouched, not doubled.
    expect(after!.liquidity).toBe(DELTA);
    expect(after!.depositedToken0.toString()).toBe(
      applied!.depositedToken0.toString(),
    );
    expect(after!.depositedToken1.toString()).toBe(
      applied!.depositedToken1.toString(),
    );
    expect(after!.totalGasCostETH.toString()).toBe(
      applied!.totalGasCostETH.toString(),
    );
    expect(after!.lastModifyBlock).toBe(BigInt(MINT_BLOCK));
    // Pool, tick and the rollups: the shared accumulators the guard was added
    // for, and the reason the replay path still skips them.
    const poolAfter = await pool(ix);
    expect(poolAfter!.liquidity).toBe(poolBefore!.liquidity);
    expect(poolAfter!.txCount).toBe(poolBefore!.txCount);
  }, 120_000);

  it("heals every event of a replayed window, not only the first", async () => {
    const ix = createTestIndexer();
    await process(ix, INIT_BLOCK, INIT_BLOCK, [initialize]);

    // A whole window's ledger survived without its position writes — the shape
    // of the live episodes, where a later event of the same position was lost
    // too and left `updatedAtBlock` stranded at the mint block.
    seedLedger(ix, ledgerRow(1738000012, MINT_LOG_INDEX, TX, DELTA));
    seedLedger(ix, ledgerRow(1738000102, SECOND_LOG_INDEX, TX2, DELTA2));

    await process(ix, MINT_BLOCK, MINT_BLOCK, [mintTransfer, mintModify]);
    await process(ix, SECOND_BLOCK, SECOND_BLOCK, [secondModify]);

    const pos = await position(ix);
    expect(pos!.poolId).toBe(POOL_ID);
    // BOTH events folded in — once each.
    expect(pos!.liquidity).toBe(DELTA + DELTA2);
    expect(pos!.updatedAtBlock).toBe(BigInt(SECOND_BLOCK));
    expect(pos!.lastModifyBlock).toBe(BigInt(SECOND_BLOCK));
    expect(pos!.lastModifyLogIndex).toBe(BigInt(SECOND_LOG_INDEX));
  }, 120_000);

  it("keeps serving a closed position: liquidity 0 with a real poolId, never hidden", async () => {
    const ix = createTestIndexer();
    await process(ix, INIT_BLOCK, INIT_BLOCK, [initialize]);
    await process(ix, MINT_BLOCK, MINT_BLOCK, [mintTransfer, mintModify]);

    // Full withdraw: the position closes.
    await process(ix, SECOND_BLOCK, SECOND_BLOCK, [
      modifyLiquidity(SECOND_BLOCK, 1738000102, SECOND_LOG_INDEX, TX2, -DELTA),
    ]);

    const pos = await position(ix);
    expect(pos).toBeDefined();
    expect(pos!.liquidity).toBe(0n);
    expect(pos!.isActive).toBe(false);
    // The point: zero liquidity is a REAL state, not a reason to drop the row.
    expect(pos!.poolId).toBe(POOL_ID);
    expect(pos!.tickLower).toBe(-60n);
    expect(pos!.tickUpper).toBe(60n);
  }, 120_000);
});
