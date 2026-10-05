/*
 * Periodic uncollected-fee refresh — the port of Ponder's `FeeSync:block`.
 *
 * Ponder declares this as `blocks: { FeeSync: { interval, startBlock: "latest" } }`.
 * The Envio equivalent is `indexer.onBlock` with an `_every` stride, and the
 * handler context is an alias of the event context, so it has both entity writes
 * and the effect caller.
 *
 * `startBlock: "latest"` IS LOAD-BEARING, AND ENVIO CANNOT EXPRESS IT
 *
 * Ponder's sweep runs ONLY at the chain head; it never fires during a historical
 * backfill. Envio's `onBlock` `where` predicate is evaluated once per chain at
 * REGISTRATION time, so it cannot encode head-proximity — a `_every` stride
 * matches historical blocks just the same. Registering this sweep across a
 * backfill range means, for the two chains currently enabled, roughly 14,100
 * firings on Ethereum and 32,150 on Avalanche, each one a stale-set query plus a
 * chunk of RPC, and all of it pure waste: uncollected fees are a CURRENT-STATE
 * quantity, so a value read at historical block N is overwritten by the next
 * firing and is never observable by any consumer.
 *
 * So `startBlock: "latest"` is reproduced in TWO layers (`src/utils/chainHead.ts`).
 *
 * The first is a `_gte` floor at the chain head as of process start, passed to
 * `where`. Envio then never creates a block item below that floor, so a backfill
 * costs nothing here at all — not even a no-op handler call per stride. This is
 * the layer that makes indexing fast, and it is why the sweep's RPC never
 * competes with the backfill for the node.
 *
 * The second is the runtime gate, which handles what a fixed floor cannot: a
 * startup where the head could not be read, and an indexer that LOSES the head
 * later. It latches — once a chain reaches the tip it stays enabled through
 * ordinary lag, and only disables again on a backfill-sized regression.
 *
 * A block-handler item carries only its block NUMBER — Envio builds it "from the
 * handler's own block number, not from the stores" — so neither layer can use a
 * timestamp; both are block-distance tests.
 *
 * WHAT A FIRING DOES lives in `src/utils/feeSweep.ts` (`sweepUncollectedFees`),
 * split out so it can be tested with a mock context — this file cannot be
 * imported by a test, because of the top-level `await` and the registration
 * below. This file keeps the registration, the preload early-return, the head
 * gate and the clock. The rules a firing follows, each argued at length there:
 *
 * 1. Two watermarks. It always writes `feesUpdatedAtBlock`, and moves
 *    `updatedAtBlock` ONLY when it heals `liquidity` / `isActive` from chain.
 *    The backend's live listener watches `updatedAtBlock` as a change feed, so
 *    stamping it on every refresh (what Ponder originally did, with one column
 *    for both) presents the entire active set as "changing" every sweep and fans
 *    out thousands of position refreshes for quantities that never moved —
 *    that was the reported hourly stall's second half. A heal, though, IS a
 *    position change, and the sweep used to heal silently; it no longer does.
 *
 * 2. It reads EVERY candidate, in range or out. It used to read only in-range
 *    positions and write 0/0 for the rest unread, on the claim that an
 *    out-of-range position has exactly zero uncollected fees. That is false —
 *    fees accrued while it was in range stay claimable after it leaves — and
 *    was verified false on chain (mainnet tokenIds 10014, 100022).
 *
 * 3. Uncollected = toUint256(feeGrowthInside − checkpoint) × L / 2^128, the
 *    contract's own modular math (`utils/fees.ts`), against the checkpoint read
 *    in the same multicall. The old negative-delta clamp zeroed the ordinary
 *    out-of-range reading.
 *
 * 4. It is bounded per firing (400 positions, one multicall per 400). Ponder
 *    originally selected every active position with no limit, and once one
 *    firing exceeded its interval each further interval queued another full
 *    refresh — which is how two of its four chains ended up permanently frozen.
 *
 * Ponder's `onFeeSync` (apps/v4/src/handlers/position-side.ts) now follows the
 * same four rules and is the chain-verified reference for 2 and 3 (uncollected
 * fees matched on-chain StateView math on 1,000/1,000 + 144/144 positions).
 */

import { indexer } from "envio";

import { v4AddressesFor } from "../utils/v4Addresses";
import { headAtStartup, isAtChainHead } from "../utils/chainHead";
import { feeSweepChainIds } from "../utils/v4Addresses";
import { activeChainIds } from "../utils/chains";
import { sweepUncollectedFees } from "../utils/feeSweep";

/**
 * Blocks between sweeps, per chain — every chain targets **45 minutes**.
 *
 * `blocks = round(2700 / blockTime)`, with each chain's block time measured
 * rather than assumed (see the per-line comments). A uniform wall-clock cadence
 * is the point: the previous table mixed 21, 30, 33 and 60-minute targets, so
 * how stale an uncollected-fee figure could be depended on which chain a
 * position happened to be on.
 *
 * THIS DEVIATES FROM PONDER on two chains, deliberately. Arbitrum (8000, ~33
 * min) and Avalanche (1200, ~21 min) carried Ponder's `feeSyncIntervalBlocks`
 * verbatim; they now sweep at 45 minutes like everything else. Ponder's values
 * were a cadence choice, not a correctness one, so parity costs nothing here.
 *
 * Unlike Ponder's, `_every` alignment is deterministic relative to the start
 * block, so the phase does not re-anchor on every process restart.
 *
 * Linea is the one chain where 45 minutes is an average rather than a bound —
 * its cadence swings between roughly 5.5 s and 9.0 s per block, so the interval
 * uses a 200,000-block mean of 8.6954 s and individual sweeps land anywhere from
 * ~29 to ~47 minutes apart. More frequent sweeps only cost RPC, so the fast end
 * is harmless.
 */
const SWEEP_INTERVAL_BLOCKS: Readonly<Record<number, number>> = {
  1: 224, // ethereum ~12.05s -> 45 min
  10: 1350, // optimism ~2.0s -> 45 min
  56: 6000, // bnb chain ~0.45s -> 45 min
  130: 2700, // unichain ~1.0s -> 45 min
  137: 1800, // polygon ~1.5s -> 45 min
  143: 8911, // monad ~0.303s -> 45 min
  480: 1350, // world chain ~2.0s -> 45 min
  1868: 1350, // soneium ~2.0s -> 45 min
  4326: 2700, // megaeth ~1.0s -> 45 min
  4663: 27000, // robinhood ~0.1s -> 45 min
  8453: 1350, // base ~2.0s -> 45 min
  42161: 10800, // arbitrum ~0.25s -> 45 min
  42220: 2700, // celo ~1.0s -> 45 min
  43114: 2547, // avalanche ~1.06s -> 45 min
  57073: 2700, // ink ~1.0s -> 45 min
  59144: 311, // linea ~8.6954s -> 45 min
  81457: 1350, // blast ~2.0s -> 45 min
  7777777: 1350, // zora ~2.0s -> 45 min
};

// The per-firing cap and the multicall chunk size (`SWEEP_BATCH_SIZE`,
// `SWEEP_CHUNK`) live with the sweep body in `src/utils/feeSweep.ts`.

/*
 * The chain heads as of process start, used as a `_gte` floor below.
 *
 * TOP-LEVEL AWAIT, DELIBERATELY. `where` is synchronous and runs once per chain
 * at registration, so the only place to learn the head before registering is
 * here, at module load. `headAtStartup` bounds itself with a timeout and
 * degrades to an empty map, so a sick RPC delays startup by that timeout at
 * worst — it cannot hang or fail the indexer.
 *
 * Only the sweepable chains are asked, so this is at most five cheap calls made
 * in parallel, once per process.
 */
const startupHeads = await headAtStartup(
  // Only chains this process actually indexes. `feeSweepChainIds()` is every
  // chain with a StateView address, which is a superset of the uncommented
  // chains in config.yaml — asking the rest would fire RPC at endpoints we
  // never use. When the config cannot be read the set is empty, and asking
  // nothing would silently disable the floor everywhere, so fall back to the
  // full candidate list in that case.
  (() => {
    const active = activeChainIds();
    const candidates = feeSweepChainIds();
    return active.size === 0 ? candidates : candidates.filter((id) => active.has(id));
  })(),
);

indexer.onBlock(
  {
    name: "feeSync",
    where: ({ chain }) => {
      const interval = SWEEP_INTERVAL_BLOCKS[chain.id];
      // A chain with no StateView address or no interval cannot be swept, and
      // returning false skips it entirely rather than firing a no-op handler.
      if (!interval || !v4AddressesFor(chain.id)) return false;

      /*
       * `_gte` at the head-as-of-startup is what makes a backfill cost NOTHING
       * here, rather than costing a cheap-but-nonzero no-op per stride.
       *
       * Without it Envio generates a block item for every `_every` stride across
       * the whole historical range — ~14,100 on Ethereum and ~32,150 on
       * Avalanche — and invokes the handler for each, which then has to ask
       * whether it is at the head and return. With it, those items are never
       * created: the sweep begins firing exactly when indexing reaches the tip.
       *
       * `_every` alignment becomes relative to `_gte` (per Envio's own docs on
       * the filter), which is fine — the stride's phase is arbitrary, only its
       * period matters.
       *
       * A chain missing from the map is one whose head could not be read at
       * startup. It registers with no floor, exactly as before, and the runtime
       * gate in the handler carries the whole burden. Slower, never wrong.
       */
      const floor = startupHeads.get(chain.id);
      return floor === undefined
        ? { block: { number: { _every: interval } } }
        : { block: { number: { _every: interval, _gte: floor } } };
    },
  },
  async ({ block, context }) => {
    /*
     * Envio runs block handlers TWICE — once with `isPreload: true` to warm
     * loads and effects in parallel, then again for real (`EventProcessing.res`
     * dispatches `Block(...)` items in the preload pass). Entity writes are
     * safely discarded in that pass (`set` is `noopSet` under preload), so
     * nothing double-counts.
     *
     * THE EARLY RETURN IS CORRECT. Its old justification was not, and the wrong
     * reason is worth naming because it appears elsewhere in this repo: it
     * claimed the preload pass issues the multicall and "the real pass issues it
     * again". It does not. On 3.7.0 a successful effect result is memoised in an
     * in-memory dict (`LoadLayer.res.mjs:82` -> `InMemoryStore.res.mjs:66-83`)
     * that is cleared only BEFORE the preload pass, and the real pass reads
     * straight out of it (`LoadManager.res.mjs:80`, reached because
     * `UserContext.res.mjs:69` passes `isPreload` through as `shouldGroup`).
     * The `cache` flag controls DB persistence, not that dict.
     *
     * THE REAL REASON, which does hold: the memo is keyed on the effect INPUT,
     * and this effect's input is the `positions` ARRAY assembled by
     * `sweepUncollectedFees`. Its membership is derived from a
     * `Position.getWhere` on `feesUpdatedAtBlock` plus the pool/token lookups —
     * state the preload pass cannot have settled, since its own writes are
     * discarded (an earlier batch's events can move rows in or out of the stale
     * set and of the active filter) — so the two passes would in general
     * build DIFFERENT arrays, produce different keys, and miss the memo
     * entirely. A warm-up that cannot be hit is a whole extra multicall per
     * firing, so returning early halves the sweep's node load.
     *
     * Nothing is lost by skipping it either way: the sweep's reads are one
     * batched effect the real pass awaits anyway, not the many independent
     * loads preload exists to overlap.
     */
    if (context.isPreload) return;

    const chainId = context.chain.id;
    const addresses = v4AddressesFor(chainId);
    if (!addresses) return;

    const interval = BigInt(SWEEP_INTERVAL_BLOCKS[chainId] ?? 0);
    const blockNumber = BigInt(block.number);

    /*
     * The runtime head gate — now a SECOND line of defence rather than the
     * first, since the `_gte` floor above normally stops these items existing.
     *
     * It still matters in two cases. One: the startup head could not be read,
     * so there is no floor. Two: the indexer LOSES the head later — an RPC
     * outage or a deep rollback leaves it processing blocks that are above the
     * floor but far below the current tip, and sweeping those is as pointless as
     * sweeping a backfill.
     *
     * `isAtChainHead` LATCHES: once a chain has reached the tip it stays enabled
     * through ordinary lag, and only switches off again on a backfill-sized
     * regression. That is what stops the sweep flapping on and off during normal
     * live operation, where being a few hundred blocks behind between firings is
     * expected rather than exceptional.
     */
    if (!(await isAtChainHead(chainId, blockNumber, interval, context.log))) return;

    /*
     * WHEN THE SWEEP RAN — not the block's own time, which a block handler is
     * never given (see the header).
     *
     * These are two different facts and the row records both: the VALUE is as of
     * `feesUpdatedAtBlock`, and `feesUpdatedAtTimestamp` is when we measured it.
     * They coincide while the indexer is at the tip, and the gate above is
     * latched, so they can diverge by up to the relatch window — a few hours —
     * when the indexer is lagging. A consumer that cares about the data's age
     * should read `feesUpdatedAtBlock`; this column answers "when did the
     * refresh last run", which is what a staleness monitor wants.
     *
     * The port previously wrote `position.feesUpdatedAtTimestamp` here, i.e. the
     * row's own previous value, which left it permanently 0.
     *
     * The same clock stamps `updatedAtTimestamp` on a HEALED row, alongside
     * `updatedAtBlock` = this block. Every other writer of that pair uses the
     * event's block timestamp; this is the one writer that has none, so on a
     * healed row the timestamp is "when the sweep saw it", and the block number
     * is the authoritative half.
     */
    const sweptAt = BigInt(Math.floor(Date.now() / 1000));

    const summary = await sweepUncollectedFees(context, {
      chainId,
      blockNumber,
      interval,
      sweptAt,
      addresses,
    });
    if (summary.candidates === 0) return;

    // `outOfRange` counts positions READ while out of range — rows the sweep used
    // to zero unread. `healed` counts liquidity/isActive corrections, the only
    // writes that move `updatedAtBlock`.
    context.log.info(
      `feeSync chain=${chainId} block=${block.number} candidates=${summary.candidates} ` +
        `read=${summary.read} out-of-range=${summary.outOfRange} failed=${summary.failed} ` +
        `healed=${summary.healed} skipped=${summary.skipped}`,
    );
  },
);
