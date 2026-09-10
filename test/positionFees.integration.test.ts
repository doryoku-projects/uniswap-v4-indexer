/*
 * End-to-end test of position fee tracking, fully offline.
 *
 * `simulate` feeds synthetic events instead of fetching from real sources, so
 * this needs no ENVIO_API_TOKEN and no HyperSync. The one external dependency,
 * the archive eth_call behind `getPositionInfoAt`, is served by a mock JSON-RPC
 * server started in-process. That makes the whole path assertable:
 *
 *   ModifyLiquidity event -> Effect -> eth_call -> decode -> fee math -> entity
 *
 * The fee arithmetic itself is covered separately and exhaustively in
 * test/positionMath.test.ts; this file proves the wiring around it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { BigDecimal, createTestIndexer } from "envio";
import { Q128 } from "../src/utils/positionMath";

const CHAIN = 1;
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const POSITION_MANAGER = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
const ROUTER = "0x1111111111111111111111111111111111111111"; // not the PositionManager
const POOL_BYTES32 = "0x" + "ab".repeat(32);
const POOL_ID = `${CHAIN}_${POOL_BYTES32}`;
const TOKEN0 = "0x0000000000000000000000000000000000000000";
const TOKEN1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const Q96 = 79228162514264337593543950336n;
const TOKEN_ID = 424242n;
const LIQUIDITY = 10n ** 18n;

// Mutable state the mock RPC returns for getPositionInfo. Each test sets the
// feeGrowthInsideLast the contract would hold AFTER the block being simulated.
let mockPositionInfo = { liquidity: 0n, fg0: 0n, fg1: 0n };
/** When true the mock rejects eth_call, simulating a missing/failing archive RPC. */
let mockFail = false;
let server: Server;

function jsonRpcResult(id: unknown, result: string) {
  return { jsonrpc: "2.0", id, result };
}

/** Answer any eth_call with the current mockPositionInfo, ABI-encoded. */
function handle(req: { id?: unknown; method?: string }) {
  switch (req.method) {
    case "eth_chainId":
      return jsonRpcResult(req.id, "0x1");
    case "eth_call":
      if (mockFail) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "missing trie node (simulated pruned state)" },
        };
      }
      return jsonRpcResult(
        req.id,
        encodeAbiParameters(parseAbiParameters("uint128, uint256, uint256"), [
          mockPositionInfo.liquidity,
          mockPositionInfo.fg0,
          mockPositionInfo.fg1,
        ]),
      );
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unsupported in mock" } };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      // viem is configured with batch: true, so a body may be an array.
      const out = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // Read lazily by rpcUrlFor(), so setting it before the first effect call is
  // enough — no module re-import needed.
  process.env.ENVIO_MAINNET_RPC_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.ENVIO_MAINNET_RPC_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

/** Preset the pool/token/manager rows the ModifyLiquidity handler requires. */
function seed(indexer: ReturnType<typeof createTestIndexer>) {
  const zeroBD = new BigDecimal("0");
  indexer.Bundle.set({ id: String(CHAIN), ethPriceUSD: new BigDecimal("2000") });

  indexer.PoolManager.set({
    id: `${CHAIN}_${POOL_MANAGER}`,
    chainId: BigInt(CHAIN),
    poolCount: 1n,
    txCount: 0n,
    totalVolumeUSD: zeroBD,
    totalVolumeETH: zeroBD,
    totalFeesUSD: zeroBD,
    totalFeesETH: zeroBD,
    untrackedVolumeUSD: zeroBD,
    totalValueLockedUSD: zeroBD,
    totalValueLockedETH: zeroBD,
    totalValueLockedUSDUntracked: zeroBD,
    totalValueLockedETHUntracked: zeroBD,
    owner: POOL_MANAGER,
    numberOfSwaps: 0n,
    hookedPools: 0n,
    hookedSwaps: 0n,
  });

  for (const [id, symbol, decimals] of [
    [TOKEN0, "ETH", 18n],
    [TOKEN1, "WETH", 18n],
  ] as const) {
    indexer.Token.set({
      id: `${CHAIN}_${id}`,
      chainId: BigInt(CHAIN),
      symbol,
      name: symbol,
      decimals,
      decimalsResolved: true,
      totalSupply: 0n,
      volume: zeroBD,
      volumeUSD: zeroBD,
      untrackedVolumeUSD: zeroBD,
      feesUSD: zeroBD,
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: zeroBD,
      totalValueLockedUSD: zeroBD,
      totalValueLockedUSDUntracked: zeroBD,
      derivedETH: new BigDecimal("1"),
      whitelistPools: [POOL_ID],
    });
  }

  indexer.Pool.set({
    id: POOL_ID,
    chainId: BigInt(CHAIN),
    name: "ETH/WETH",
    createdAtTimestamp: 1000n,
    createdAtBlockNumber: 1000n,
    token0: `${CHAIN}_${TOKEN0}`,
    token1: `${CHAIN}_${TOKEN1}`,
    feeTier: 3000n,
    liquidity: 0n,
    sqrtPrice: Q96, // price 1, tick 0
    token0Price: new BigDecimal("1"),
    token1Price: new BigDecimal("1"),
    tick: 0n,
    tickSpacing: 60n,
    observationIndex: 0n,
    volumeToken0: zeroBD,
    volumeToken1: zeroBD,
    volumeUSD: zeroBD,
    untrackedVolumeUSD: zeroBD,
    feesUSD: zeroBD,
    feesUSDUntracked: zeroBD,
    txCount: 0n,
    collectedFeesToken0: zeroBD,
    collectedFeesToken1: zeroBD,
    collectedFeesUSD: zeroBD,
    totalValueLockedToken0: zeroBD,
    totalValueLockedToken1: zeroBD,
    totalValueLockedETH: zeroBD,
    totalValueLockedUSD: zeroBD,
    totalValueLockedUSDUntracked: zeroBD,
    liquidityProviderCount: 0n,
    hooks: "0x0000000000000000000000000000000000000000",
  });
}

/**
 * One ModifyLiquidity simulate item. Block numbers deliberately avoid multiples
 * of 300 so the FeeSync `_every` stride for chain 1 never fires here.
 */
function modify(opts: {
  block: number;
  logIndex: number;
  liquidityDelta: bigint;
  sender?: string;
  txHash?: string;
  gasUsed?: bigint;
}) {
  return {
    contract: "PoolManager" as const,
    event: "ModifyLiquidity" as const,
    srcAddress: POOL_MANAGER as `0x${string}`,
    logIndex: opts.logIndex,
    block: { number: opts.block, timestamp: 1_700_000_000 + opts.block },
    transaction: {
      hash: (opts.txHash ??
        `0x${opts.block.toString(16).padStart(64, "0")}`) as `0x${string}`,
      from: "0x9999999999999999999999999999999999999999" as `0x${string}`,
      gasUsed: opts.gasUsed ?? 0n,
      effectiveGasPrice: opts.gasUsed ? 10n ** 9n : 0n,
    },
    params: {
      id: POOL_BYTES32 as `0x${string}`,
      sender: (opts.sender ?? POSITION_MANAGER) as `0x${string}`,
      tickLower: -60n,
      tickUpper: 60n,
      liquidityDelta: opts.liquidityDelta,
      salt: `0x${TOKEN_ID.toString(16).padStart(64, "0")}` as `0x${string}`,
    },
  };
}

describe("position fee tracking (offline, mock RPC)", () => {
  beforeEach(() => {
    mockFail = false;
  });

  it("creates a Position and a DEPOSIT row on the first add, with zero fees", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    // The contract's baseline after the mint. Fees are still 0 because
    // liquidityBefore was 0 — the contract reads liquidity before the delta.
    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 7n * Q128, fg1: 3n * Q128 };

    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.liquidity).toBe(LIQUIDITY);
    expect(p.isActive).toBe(true);
    expect(p.isPriceable).toBe(true);
    // BARE bytes32, deliberately NOT the namespaced POOL_ID that `Pool.id`
    // carries. The Tickwise backend feeds this value back into
    // `pools(where: {id_in: …})`, where its own `pool` id class re-adds the
    // `<chainId>_` prefix — so a namespaced value here would be prefixed twice
    // and match nothing, returning a well-formed empty list.
    expect(p.poolId).toBe(POOL_BYTES32);
    expect(p.poolId).not.toBe(POOL_ID);
    expect(p.tickLower).toBe(-60n);
    expect(p.tickUpper).toBe(60n);
    expect(p.closedAtTimestamp).toBeUndefined();

    // No fees on a mint, but the baseline must be stored for the next settle.
    expect(p.totalFeesCollected0).toBe(0);
    expect(p.totalFeesCollected1).toBe(0);
    expect(p.feeGrowthInside0LastX128).toBe(7n * Q128);
    expect(p.feeGrowthInside1LastX128).toBe(3n * Q128);

    // Both tokens are deposited for an in-range position.
    expect(p.depositedToken0).toBeGreaterThan(0);
    expect(p.depositedToken1).toBeGreaterThan(0);
    expect(p.withdrawnToken0).toBe(0);

    const rows = await indexer.PositionTransaction.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("DEPOSIT");
    expect(rows[0]!.tokenId).toBe(TOKEN_ID);
  });

  it("books the EXACT collected fee on the next modify", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });

    // Fee growth advances by Q128/2 on token0 and Q128/4 on token1. With
    // liquidityBefore = 1e18 that is exactly 0.5 and 0.25 tokens:
    //   mulDiv(Q128/2, 1e18, Q128) = 5e17 raw = 0.5 at 18 decimals
    mockPositionInfo = { liquidity: LIQUIDITY, fg0: Q128 / 2n, fg1: Q128 / 4n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1002, logIndex: 1, liquidityDelta: 0n })] } },
    });

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.totalFeesCollected0).toBe(0.5);
    expect(p.totalFeesCollected1).toBe(0.25);
    // Settled, so nothing outstanding until FeeSync runs at head.
    expect(p.totalFeesUncollected0).toBe(0);

    const collects = (await indexer.PositionTransaction.getAll()).filter(
      (r) => r.type === "COLLECT_FEES",
    );
    expect(collects).toHaveLength(1);
    expect(collects[0]!.amount0).toBe(0.5);
    expect(collects[0]!.amount1).toBe(0.25);
    // A pure collect moves no liquidity, so it writes no DEPOSIT/WITHDRAW row.
    expect(await indexer.PositionTransaction.getAll()).toHaveLength(2);
  });

  it("books zero on a second modify in the SAME block", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });

    // Two modifies in one block both read the SAME end-of-block baseline, so
    // the first settles the whole delta and the second books nothing. That is
    // the correct split whenever no swap or donate interleaved between them.
    mockPositionInfo = { liquidity: LIQUIDITY, fg0: Q128 / 2n, fg1: 0n };
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            modify({ block: 1002, logIndex: 1, liquidityDelta: 0n, txHash: "0x" + "11".repeat(32) }),
            modify({ block: 1002, logIndex: 2, liquidityDelta: 0n, txHash: "0x" + "11".repeat(32) }),
          ],
        },
      },
    });

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    // 0.5 total, not 1.0 — the second event must not double-count.
    expect(p.totalFeesCollected0).toBe(0.5);
    const collects = (await indexer.PositionTransaction.getAll()).filter(
      (r) => r.type === "COLLECT_FEES",
    );
    expect(collects).toHaveLength(1);
  });

  it("closes the position on a full burn", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });

    mockPositionInfo = { liquidity: 0n, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1002, logIndex: 1, liquidityDelta: -LIQUIDITY })] } },
    });

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.liquidity).toBe(0n);
    expect(p.isActive).toBe(false);
    expect(p.closedAtTimestamp).toBe(BigInt(1_700_000_000 + 1002));
    expect(p.withdrawnToken0).toBeGreaterThan(0);
    expect(p.withdrawnToken1).toBeGreaterThan(0);

    const types = (await indexer.PositionTransaction.getAll()).map((r) => r.type).sort();
    expect(types).toEqual(["DEPOSIT", "WITHDRAW"]);
  });

  it("ignores liquidity that did not come from the PositionManager", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY, sender: ROUTER })],
        },
      },
    });

    // Router / hook / JIT liquidity has no tokenId and is out of scope. On
    // Robinhood that is ~58% of all ModifyLiquidity events.
    expect(await indexer.Position.getAll()).toHaveLength(0);
    expect(await indexer.PositionTransaction.getAll()).toHaveLength(0);
  });

  it("does NOT book a phantom fee when the baseline was never verified", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    // Mint while the archive RPC is unavailable: liquidity is tracked, but no
    // baseline is established.
    mockFail = true;
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });
    let p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.liquidity).toBe(LIQUIDITY);
    expect(p.feeBaselineValid).toBe(false);
    expect(p.totalFeesCollected0).toBe(0);

    // RPC comes back, and the range has meanwhile accrued a huge amount of fee
    // growth. Diffing that against the un-initialised 0 baseline would book
    // 1000 tokens of fee that this position never earned.
    mockFail = false;
    mockPositionInfo = { liquidity: 100n * LIQUIDITY, fg0: 1000n * Q128, fg1: 1000n * Q128 };
    await indexer.process({
      chains: {
        [CHAIN]: { simulate: [modify({ block: 1002, logIndex: 1, liquidityDelta: 99n * LIQUIDITY })] },
      },
    });
    p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.totalFeesCollected0).toBe(0); // NOT 1000
    expect(p.totalFeesCollected1).toBe(0);
    expect(p.feeBaselineValid).toBe(true); // baseline initialised, not settled
    expect(p.feeGrowthInside0LastX128).toBe(1000n * Q128);

    // From here fees settle normally, against the now-verified baseline.
    mockPositionInfo = {
      liquidity: 100n * LIQUIDITY,
      fg0: 1000n * Q128 + Q128 / 2n,
      fg1: 1000n * Q128,
    };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1003, logIndex: 1, liquidityDelta: 0n })] } },
    });
    p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    // mulDiv(Q128/2, 100e18, Q128) = 50e18 raw = 50 tokens at 18 decimals.
    expect(p.totalFeesCollected0).toBe(50);
  });

  it("stores owner, origin and sender lowercased for Ponder parity", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: { [CHAIN]: { simulate: [modify({ block: 1001, logIndex: 1, liquidityDelta: LIQUIDITY })] } },
    });

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.owner).toBe(p.owner.toLowerCase());
    expect(p.origin).toBe(p.origin.toLowerCase());
    const rows = await indexer.PositionTransaction.getAll();
    expect(rows[0]!.sender).toBe(rows[0]!.sender.toLowerCase());
  });

  it("charges tx gas once across two position events in one transaction", async () => {
    const indexer = createTestIndexer();
    seed(indexer);

    const gasUsed = 200_000n; // x 1 gwei = 0.0002 native token
    mockPositionInfo = { liquidity: LIQUIDITY, fg0: 0n, fg1: 0n };
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            modify({
              block: 1001,
              logIndex: 1,
              liquidityDelta: LIQUIDITY,
              txHash: "0x" + "22".repeat(32),
              gasUsed,
            }),
            modify({
              block: 1001,
              logIndex: 2,
              liquidityDelta: LIQUIDITY,
              txHash: "0x" + "22".repeat(32),
              gasUsed,
            }),
          ],
        },
      },
    });

    const rows = await indexer.PositionTransaction.getAll();
    expect(rows).toHaveLength(2);
    const total = rows.reduce((s, r) => s + r.gasCostETH, 0);
    // The sum across rows must equal the real tx cost, not twice it.
    expect(total).toBeCloseTo(0.0002, 12);

    const p = await indexer.Position.getOrThrow(`${CHAIN}_${TOKEN_ID}`);
    expect(p.totalGasCostETH).toBeCloseTo(0.0002, 12);
    expect(p.liquidity).toBe(2n * LIQUIDITY);
  });
});
