/*
 * THE TRACE PREFETCH MUST CHANGE COST, NEVER A VALUE.
 *
 * `getFeesAccrued` is prefetched in the preload pass (modifyLiquidity-handler.ts,
 * the `Position.get(...).then(...)` entry) so the serial pass reads the trace
 * out of the in-batch memo instead of paying `debug_traceTransaction` latency
 * one event at a time. The real pass still decides whether the trace is read.
 * These tests drive the real handler through `createTestIndexer`, which runs
 * BOTH passes, and count trace requests per transaction at the `fetch` layer:
 *
 *   1. Two collects in one batch are traced CONCURRENTLY — the prefetch is live.
 *   2. A mint is never traced, prefetch included.
 *   3. Mint then increase in the SAME batch: the batch-start snapshot has no
 *      row, so nothing is prefetched, and the real pass still traces it — one
 *      serial call, the fee still recorded.
 *   4. A prefetch whose whole retry ladder fails is recovered by
 *      `getFeesAccruedRetry` in the real pass, not replayed from the memo.
 *   5. A transaction that fails both ladders costs exactly two invocations,
 *      however many events in it need the trace.
 *
 * `createTestIndexer` never loads or persists effect caches
 * (TestIndexer.res:89, `dumpEffectCache` is a no-op), so the committed
 * `.envio/cache` TSVs can neither answer these calls nor be written by them.
 * Every non-trace RPC answers -32601, the capability-gap path, as in
 * positionReplayHeal.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";
import { encodeFunctionData } from "viem";

import { MODIFY_LIQ_ABI } from "./effects/feesAccrued";

const CHAIN = 1;
const POOL_ID = "0x2222222222222222222222222222222222222222222222222222222222222222";
const POOL_MGR = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const POS_MGR = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
const OWNER = "0x31E3E4c1ad0DC13f2D8c58C0b1fD9fD9Dd6bE1f5";
const CURRENCY0 = "0x0000000000000000000000000000000000000000";
const CURRENCY1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const HOOKS = "0x0000000000000000000000000000000000000000";
const TICK_LOWER = -60n;
const TICK_UPPER = 60n;
const MINT_DELTA = 2760743263836633442467n;

const INIT_BLOCK = 21800000;
const MINT_BLOCK = 21800001;
const LATER_BLOCK = 21800010;

/** Synthetic, so no cache of any kind can know them. */
const tx = (n: number) => "0xfee5" + n.toString(16).padStart(60, "0");
const salt = (tokenId: bigint) => "0x" + tokenId.toString(16).padStart(64, "0");

// Fee magnitudes the stub reports for every traced frame.
const FEE0 = 10n ** 15n;
const FEE1 = 5_000_000n;

// ─── the fetch stub ──────────────────────────────────────────────────────────

type RpcReq = { id: number; method: string; params?: unknown[] };

/** tx hash -> the frames its trace should contain. */
const traces = new Map<string, { tokenId: bigint; liquidityDelta: bigint }[]>();
/** tx hash -> how many trace attempts to answer with an unusable (reverted) trace. */
const failFirst = new Map<string, number>();
/** tx hash -> trace requests seen. */
const traceCalls = new Map<string, number>();
let inFlight = 0;
let maxInFlight = 0;

const frameFor = (tokenId: bigint, liquidityDelta: bigint) => ({
  to: POOL_MGR,
  input: encodeFunctionData({
    abi: MODIFY_LIQ_ABI,
    functionName: "modifyLiquidity",
    args: [
      { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3000, tickSpacing: 60, hooks: HOOKS },
      {
        tickLower: Number(TICK_LOWER),
        tickUpper: Number(TICK_UPPER),
        liquidityDelta,
        salt: salt(tokenId) as `0x${string}`,
      },
      "0x",
    ],
  }),
  // (callerDelta, feesAccrued): feesAccrued packs amount0 in the high 128 bits.
  output:
    "0x" + "0".repeat(64) + ((FEE0 << 128n) | FEE1).toString(16).padStart(64, "0"),
});

const answer = async (req: RpcReq) => {
  if (req.method !== "debug_traceTransaction") {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "the method does not exist" } };
  }
  const hash = String((req.params ?? [])[0]).toLowerCase();
  const seen = (traceCalls.get(hash) ?? 0) + 1;
  traceCalls.set(hash, seen);

  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  // Long enough that two prefetches overlap, short enough to keep the file fast.
  await new Promise((r) => setTimeout(r, 40));
  inFlight -= 1;

  if (seen <= (failFirst.get(hash) ?? 0)) {
    // The flaky-provider shape feesAccrued.ts retries on: no usable output.
    return { jsonrpc: "2.0", id: req.id, result: { error: "execution reverted" } };
  }
  const frames = (traces.get(hash) ?? []).map((f) => frameFor(f.tokenId, f.liquidityDelta));
  const [first, ...rest] = frames;
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: first ? { ...first, calls: rest } : { error: "execution reverted" },
  };
};

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as RpcReq | RpcReq[];
    const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  traces.clear();
  failFirst.clear();
  traceCalls.clear();
  inFlight = 0;
  maxInFlight = 0;
});

// ─── events ──────────────────────────────────────────────────────────────────

const initialize = {
  contract: "PoolManager",
  event: "Initialize",
  srcAddress: POOL_MGR,
  logIndex: 1,
  block: { number: INIT_BLOCK, timestamp: 1739000000 },
  params: {
    id: POOL_ID,
    currency0: CURRENCY0,
    currency1: CURRENCY1,
    fee: 3000n,
    tickSpacing: 60n,
    hooks: HOOKS,
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0n,
  },
};

const mintTransfer = (tokenId: bigint, hash: string, logIndex: number, block = MINT_BLOCK) => ({
  contract: "PositionManager",
  event: "Transfer",
  srcAddress: POS_MGR,
  logIndex,
  block: { number: block, timestamp: 1739000000 + (block - INIT_BLOCK) * 12 },
  transaction: { hash, from: OWNER },
  params: { from: "0x0000000000000000000000000000000000000000", to: OWNER, id: tokenId },
});

const modify = (
  tokenId: bigint,
  hash: string,
  logIndex: number,
  liquidityDelta: bigint,
  block: number,
) => ({
  contract: "PoolManager",
  event: "ModifyLiquidity",
  srcAddress: POOL_MGR,
  logIndex,
  block: { number: block, timestamp: 1739000000 + (block - INIT_BLOCK) * 12 },
  transaction: { hash, from: OWNER, gasUsed: 300000n, effectiveGasPrice: 1000000000n, l1Fee: 0n },
  params: {
    id: POOL_ID,
    sender: POS_MGR,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    liquidityDelta,
    salt: salt(tokenId),
  },
});

const run = (
  ix: ReturnType<typeof createTestIndexer>,
  startBlock: number,
  endBlock: number,
  simulate: unknown[],
) => ix.process({ chains: { [CHAIN]: { startBlock, endBlock, simulate } } } as never);

const position = (ix: ReturnType<typeof createTestIndexer>, tokenId: bigint) =>
  (ix as unknown as {
    Position: {
      get: (id: string) => Promise<
        { liquidity: bigint; totalFeesCollected0: BigDecimal; totalFeesCollected1: BigDecimal } | undefined
      >;
    };
  }).Position.get(`${CHAIN}_${tokenId}`);

/*
 * Initialize runs in its OWN, earlier batch, and that is load-bearing. Preload
 * writes are no-ops, so a pool initialised in the same batch has no row at batch
 * start and the preload returns at the handler's `if (!existingPool) return`
 * — BEFORE the trace gate. A mint test built that way passes whether or not the
 * gate keeps mints off the prefetch; verified by forcing the gate to `true`.
 */
const initPool = (ix: ReturnType<typeof createTestIndexer>) =>
  run(ix, INIT_BLOCK, INIT_BLOCK, [initialize]);

/** Initialize the pool, then mint `tokenIds` — one transaction each — in a later batch. */
const mintAll = async (ix: ReturnType<typeof createTestIndexer>, tokenIds: bigint[]) => {
  await initPool(ix);
  const events: unknown[] = [];
  tokenIds.forEach((id, i) => {
    events.push(mintTransfer(id, tx(900 + i), 10 + i * 2));
    events.push(modify(id, tx(900 + i), 11 + i * 2, MINT_DELTA, MINT_BLOCK));
  });
  await run(ix, MINT_BLOCK, MINT_BLOCK, events);
};

const calls = (hash: string) => traceCalls.get(hash.toLowerCase()) ?? 0;

// ─── tests ───────────────────────────────────────────────────────────────────

describe("getFeesAccrued prefetch", () => {
  it("never traces a mint, in either pass", async () => {
    const ix = createTestIndexer();
    await mintAll(ix, [7001n]);

    expect(calls(tx(900))).toBe(0);
    expect((await position(ix, 7001n))?.liquidity).toBe(MINT_DELTA);
  });

  it("prefetches collects in the preload pass: their traces overlap, and each is taken once", async () => {
    const ix = createTestIndexer();
    await mintAll(ix, [7101n, 7102n]);

    const a = tx(1);
    const b = tx(2);
    traces.set(a.toLowerCase(), [{ tokenId: 7101n, liquidityDelta: 0n }]);
    traces.set(b.toLowerCase(), [{ tokenId: 7102n, liquidityDelta: 0n }]);

    await run(ix, LATER_BLOCK, LATER_BLOCK, [
      modify(7101n, a, 5, 0n, LATER_BLOCK),
      modify(7102n, b, 9, 0n, LATER_BLOCK),
    ]);

    // Serial real-pass tracing can never have two in flight; only the preload
    // prefetch can. And the real pass's own call must come from the memo.
    expect(maxInFlight).toBe(2);
    expect(calls(a)).toBe(1);
    expect(calls(b)).toBe(1);
    for (const id of [7101n, 7102n]) {
      const p = await position(ix, id);
      expect(p?.totalFeesCollected0.gt(new BigDecimal(0))).toBe(true);
      expect(p?.totalFeesCollected1.gt(new BigDecimal(0))).toBe(true);
    }
  });

  it("mint then increase in ONE batch: not prefetched, still traced once by the real pass", async () => {
    /*
     * The documented miss. Preload sees the batch-start snapshot — no row — so
     * `traceGateForRow(undefined, delta > 0)` says no. The real pass sees the
     * row the mint just wrote (liquidity > 0) and traces. Cost: one serial
     * call, exactly as before the prefetch. Value: unchanged.
     */
    const ix = createTestIndexer();
    const mintTx = tx(10);
    const increaseTx = tx(11);
    traces.set(increaseTx.toLowerCase(), [{ tokenId: 7201n, liquidityDelta: 5n }]);

    await initPool(ix);
    await run(ix, MINT_BLOCK, MINT_BLOCK, [
      mintTransfer(7201n, mintTx, 10),
      modify(7201n, mintTx, 11, MINT_DELTA, MINT_BLOCK),
      modify(7201n, increaseTx, 20, 5n, MINT_BLOCK),
    ]);

    expect(calls(mintTx)).toBe(0);
    expect(calls(increaseTx)).toBe(1);
    const p = await position(ix, 7201n);
    expect(p?.liquidity).toBe(MINT_DELTA + 5n);
    expect(p?.totalFeesCollected0.gt(new BigDecimal(0))).toBe(true);
  });

  it("a prefetch whose retry ladder fails is re-traced by getFeesAccruedRetry, and the fee is kept", async () => {
    /*
     * Without the retry the real pass is served the prefetch's memoised `[]` —
     * `InMemoryStore.setEffectOutput` stores it despite `context.cache = false`
     * — and the collect is recorded as a permanent zero.
     */
    const ix = createTestIndexer();
    await mintAll(ix, [7301n]);

    const c = tx(20);
    traces.set(c.toLowerCase(), [{ tokenId: 7301n, liquidityDelta: 0n }]);
    failFirst.set(c.toLowerCase(), 5); // exactly one full ladder (TRACE_MAX_ATTEMPTS)

    await run(ix, LATER_BLOCK, LATER_BLOCK, [modify(7301n, c, 5, 0n, LATER_BLOCK)]);

    expect(calls(c)).toBe(6);
    const p = await position(ix, 7301n);
    expect(p?.totalFeesCollected0.gt(new BigDecimal(0))).toBe(true);
  });

  it("a transaction failing both ladders costs two invocations however many events need it", async () => {
    /*
     * Two positions collected in ONE transaction. The first event's real pass
     * gets `[]` from the memo and retries; the second event is served BOTH
     * memos. So the bound is 2 x TRACE_MAX_ATTEMPTS, not per event — and both
     * fees are recorded as zero, the pre-existing degraded outcome.
     */
    const ix = createTestIndexer();
    await mintAll(ix, [7401n, 7402n]);

    const d = tx(30);
    traces.set(d.toLowerCase(), [
      { tokenId: 7401n, liquidityDelta: 0n },
      { tokenId: 7402n, liquidityDelta: 0n },
    ]);
    failFirst.set(d.toLowerCase(), 100);

    await run(ix, LATER_BLOCK, LATER_BLOCK, [
      modify(7401n, d, 5, 0n, LATER_BLOCK),
      modify(7402n, d, 6, 0n, LATER_BLOCK),
    ]);

    expect(calls(d)).toBe(10);
    for (const id of [7401n, 7402n]) {
      expect((await position(ix, id))?.totalFeesCollected0.toString()).toBe("0");
    }
  });
});
