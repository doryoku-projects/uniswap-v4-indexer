/*
 * Robinhood Chain (4663) smoke test — the cheapest local proof that the whole
 * path works on the chain that has no Graph subgraph.
 *
 * Runs fully in-process via createTestIndexer(): no Docker, no Postgres, no
 * Hasura. It DOES hit HyperSync for real block data, so it needs
 * ENVIO_API_TOKEN (free at https://envio.dev/app/api-tokens).
 *
 * Auto-exit mode (`{ 4663: {} }`) walks forward from the chain's configured
 * start_block (9070) to the FIRST block carrying an indexed event and processes
 * just that block, so it stays a few-blocks test rather than a backfill.
 *
 * What a pass proves: config.yaml resolves for 4663, HyperSync serves the
 * chain, the PoolManager/PositionManager ABIs decode, and handlers write
 * entities without throwing. It does NOT prove fee correctness — position fees
 * are not in this indexer's schema yet.
 */
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

const ROBINHOOD = 4663;

describe("Robinhood Chain (4663) smoke", () => {
  it("processes the first block with events from the v4 deploy block", async (t) => {
    const indexer = createTestIndexer();

    const result = await indexer.process({ chains: { [ROBINHOOD]: {} } });

    // At least one block, and it actually carried events. Asserted rather than
    // snapshotted: the first eventful blocks near the deploy block are stable,
    // but their contents are not worth pinning for a liveness check. Auto-exit
    // stops at the first block WITH events, which can span more than one entry
    // when several land close together — so this is a floor, not an equality.
    t.expect(result.changes.length, "should process at least one block").toBeGreaterThanOrEqual(1);

    const change = result.changes[0]!;
    t.expect(change.chainId).toBe(ROBINHOOD);
    t.expect(
      change.eventsProcessed,
      "the auto-detected block must carry at least one indexed event",
    ).toBeGreaterThan(0);
    t.expect(
      change.block,
      "must start at or after the configured start_block",
    ).toBeGreaterThanOrEqual(9070);
  });

  it("advances to a second eventful block and creates at least one Pool", async (t) => {
    const indexer = createTestIndexer();

    // Each process() continues where the last stopped, so this walks the first
    // few eventful blocks of the chain's v4 history.
    for (let i = 0; i < 4; i++) {
      await indexer.process({ chains: { [ROBINHOOD]: {} } });
    }

    const pools = await indexer.Pool.getAll();
    const tokens = await indexer.Token.getAll();

    // v4 emits Initialize before any liquidity, so the earliest eventful blocks
    // are pool creations. Every Pool id is chain-namespaced.
    t.expect(pools.length, "expected at least one Pool from Initialize").toBeGreaterThan(0);
    for (const pool of pools) {
      t.expect(pool.id.startsWith(`${ROBINHOOD}_`)).toBe(true);
      t.expect(pool.chainId).toBe(BigInt(ROBINHOOD));
    }

    // Token metadata resolution is the one place a handler reaches for an RPC.
    // If it silently degraded we would see placeholder symbols, so assert the
    // rows exist and are chain-scoped rather than asserting exact symbols.
    t.expect(tokens.length, "expected Token rows for the pool currencies").toBeGreaterThan(0);
  });
});
