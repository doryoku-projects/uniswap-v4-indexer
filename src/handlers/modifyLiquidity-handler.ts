/*
 * Liquidity event handlers for Uniswap v4 pools
 */
import { indexer } from "envio";
import {
  getAmount0,
  getAmount1,
} from "../utils/liquidityMath/liquidityAmounts";
import {
  currentAmounts,
  gasCostEth,
  isDegenerate,
  newPosition,
  positionId,
  positionTxId,
  tokenIdFromSalt,
} from "../utils/positions";
import { getFeesAccrued } from "../effects/feesAccrued";
import { pickFeeFrame, saltOrdinal } from "../utils/feeFrames";
import {
  feeGate,
  readFeeGrowthInside,
  shouldTraceFees,
  traceGateCanPass,
  type FeeGateEvent,
} from "../utils/feeGate";
import { positionManagerFor } from "../utils/v4Addresses";
import { ZERO_BD } from "../utils/constants";
import { convertTokenToDecimal, sanitizeBD } from "../utils";
import { createInitialTick } from "../utils/tick";
import { getChainConfig } from "../utils/chains";
import {
  preloadIntervalData,
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
  updateUniswapDayData,
} from "../utils/intervalUpdates";

/**
 * Chains already warned about a missing PositionManager entry, so the warning
 * is one line per chain rather than one per event. Module-level, matching the
 * existing per-chain caches in utils/chainHead.ts and effects/feesAccrued.ts.
 */
const warnedNoPositionManager = new Set<number>();

indexer.onEvent({ contract: "PoolManager", event: "ModifyLiquidity" }, async ({ event, context }) => {
  // Get chain config for pools to skip
  const chainConfig = getChainConfig(event.chainId);

  // Check if this pool should be skipped
  // NOTE: Subgraph only has this check in Initialize handler since skipped pools
  // are never created, but we keep it here for safety in case we switch to
  // getOrThrow APIs in the future and don't want exceptions thrown
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  const poolId = `${event.chainId}_${event.params.id}`;

  // tick entities
  const lowerTickId = poolId + "#" + BigInt(event.params.tickLower).toString();
  const upperTickId = poolId + "#" + BigInt(event.params.tickUpper).toString();

  // Fetch pool + ticks concurrently
  const [existingPool, existingLowerTick, existingUpperTick] =
    await Promise.all([
      context.Pool.get(poolId),
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
    ]);
  if (!existingPool) return;

  // Fetch tokens, bundle, poolManager, and hookStats concurrently
  const isHookedPool =
    existingPool.hooks !== "0x0000000000000000000000000000000000000000";
  const hookStatsId = isHookedPool
    ? `${event.chainId}_${existingPool.hooks}`
    : undefined;

  const [existingToken0, existingToken1, bundle, existingPoolManager, existingHookStats] =
    await Promise.all([
      context.Token.get(existingPool.token0),
      context.Token.get(existingPool.token1),
      context.Bundle.get(event.chainId.toString()),
      context.PoolManager.getOrThrow(
        `${event.chainId}_${event.srcAddress}`
      ),
      hookStatsId ? context.HookStats.get(hookStatsId) : undefined,
    ]);
  if (!existingToken0 || !existingToken1 || !bundle) return;

  /*
   * The fee gate's whole input, built ONCE and shared by both passes.
   *
   * `existingPool` rather than the mutated `pool` below, and that is exact, not
   * approximate: `pool` is `{...existingPool}` with `txCount`,
   * `totalValueLockedToken0/1`, `liquidity`, `totalValueLockedETH` and
   * `totalValueLockedUSD` overridden (the `let pool = {...}` block below, and
   * the two reassignments after it — :240-284 at the time of writing). `tick` and
   * `sqrtPrice` — the only two fields `isDegenerate` reads — are never touched,
   * so the predicate cannot differ between the two objects.
   *
   * One object, not two constructions, because the effect memo is keyed on the
   * input: if the preload pass and the real pass built even slightly different
   * inputs, the real pass would miss the dict and pay full RPC latency inside
   * the strictly serial handler loop. See utils/feeGate.ts for the mechanism.
   */
  const feeGateEvent: FeeGateEvent = {
    chainId: event.chainId,
    sender: event.params.sender,
    salt: event.params.salt,
    poolId: event.params.id,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    blockNumber: event.block.number,
    poolTick: existingPool.tick,
    poolSqrtPrice: existingPool.sqrtPrice,
  };

  if (context.isPreload) {
    /*
     * Everything this handler can possibly need from the network or the store,
     * issued HERE so the whole batch's reads overlap.
     *
     * `preloadBatchOrThrow` runs every handler in the batch concurrently;
     * `runBatchHandlersOrThrow` then runs them one at a time. A read left
     * behind the `return` below is therefore a read taken at full latency, in
     * series, once per event — which is what `getFeeGrowthInside` was, and it
     * is issued on nearly every PositionManager ModifyLiquidity.
     *
     * The two entity reads are the same story without the RPC:
     * `Position.get` and `PositionTransaction.getWhere` are one SELECT each per
     * event in the serial pass, and collapse into grouped queries under preload
     * (`UserContext.res.mjs:69,84` pass `isPreload` through as `shouldGroup`).
     *
     * Results are discarded, exactly as `preloadIntervalData` documents at
     * utils/intervalUpdates.ts:159-171 — the point is the side effect on the
     * load layer and the effect output dict, which the real pass reads back.
     *
     * `getFeesAccrued` is deliberately NOT hoisted, and the reason CHANGED with
     * the gate. It used to be gated on the RESULT of `getFeeGrowthInside`; it is
     * now gated on the POSITION's stored liquidity, which this pass does not
     * have — the preload pass discards its reads and never reaches the position
     * block below. Hoisting it would therefore trace every transaction
     * speculatively, mints included, and mints are the bulk of ModifyLiquidity.
     * At {calls: 20, per: "second"} those speculative traces would displace real
     * ones in the same rate-limit window, for an upside capped near 1x.
     */
    const gate = feeGate(feeGateEvent);
    await Promise.all([
      // Warm the interval rows here - see the note in swap-handler.ts.
      preloadIntervalData(context, {
        blockTimestamp: event.block.timestamp,
        chainId: event.chainId,
        poolId,
        tokenIds: [existingToken0.id, existingToken1.id],
        includeUniswapDayData: true,
      }),
      readFeeGrowthInside(context, feeGateEvent),
      // The replay guard's own read, warmed here so it is grouped with the rest
      // of the batch instead of costing one serialized SELECT per event in the
      // sequential pass. Same id the guard computes below.
      context.ModifyLiquidity.get(
        `${event.chainId}_${event.transaction.hash}_${event.logIndex}`,
      ),
      // Only for a PositionManager caller: a non-attributable event never
      // reaches either read in the real pass, so warming them would be a query
      // spent on nothing.
      gate.attributable
        ? context.PositionTransaction.getWhere({
            txHash: { _eq: event.transaction.hash },
          })
        : undefined,
      // Same story, and it is the input the fee-frame ORDINAL is counted over.
      // Warming it here means the real pass reads the filter index out of memory
      // (`LoadLayer.res.mjs:242` short-circuits on `hasIndex`) instead of issuing
      // a SELECT inside the serial loop. The index is rebuilt from the DB, and
      // rows SET later in the real pass are added to it by
      // `InMemoryTable.updateIndexes`, so an earlier same-salt event of this
      // transaction is counted whether it was committed or written a moment ago.
      gate.attributable
        ? context.ModifyLiquidity.getWhere({
            transaction: { _eq: event.transaction.hash },
          })
        : undefined,
      gate.tokenId !== undefined
        ? context.Position.get(positionId(event.chainId, gate.tokenId))
        : undefined,
    ]);
    return;
  }

  /*
   * REPLAY GUARD — everything below this line is NOT idempotent.
   *
   * On 2026-09-16 the hosted indexer committed chain 4663 blocks
   * 6,686,659..6,695,055, restarted three seconds later, and resumed from a
   * checkpoint one batch BEHIND that commit (6,686,658). The entity write and
   * the progress write are not atomic, so the whole range was applied twice.
   *
   * The damage was entirely in the read-modify-write accumulators, and the
   * asymmetry is the whole diagnosis: rows keyed on
   * `chainId_txHash_logIndex` — `ModifyLiquidity`, `PositionTransaction` — are
   * written with a plain SET, so a second application OVERWRITES them and they
   * came out correct. Everything of the shape `existing.x + delta` doubled:
   * `Position.liquidity`, `depositedToken0/1`, `withdrawnToken0/1`,
   * `totalFeesCollected0/1`, `totalGasCostETH`, `Tick.liquidityGross/Net`,
   * `Pool.liquidity`/TVL/`txCount`, and every Day/Hour rollup.
   *
   * Measured: 170 of 40,641 chain-4663 positions wrong, all OVERSTATED, 65 of
   * them exactly 2x. 27 are closed on chain but stored `isActive: true` with
   * balances that no longer exist — and those never self-heal, because a closed
   * position gets no further events.
   *
   * The guard is a keyed read of the one row this event is guaranteed to have
   * written. Three reasons it is safe, each verified rather than assumed:
   *
   *  1. It cannot self-trip in the preload pass: `set` is `noopSet` there
   *     (UserContext.res.mjs:88,102), so nothing is written before this point.
   *     It also sits AFTER the preload `return` above, so it never runs twice.
   *  2. It cannot collide inside a batch: the id carries `logIndex`, so it is
   *     unique per event.
   *  3. It does not break a genuine reorg: rollback restores entities to the
   *     target checkpoint (`InMemoryStore.res.mjs:118` -> `getRollbackData`),
   *     so the row is gone before the range is legitimately re-processed.
   *
   * It must stay HERE — above `Tick.set` at the first write below — and not at
   * the `ModifyLiquidity.set` further down, or the tick and pool accumulators
   * are already doubled by the time it fires.
   *
   * ─── WHY IT IS A FLAG AND NO LONGER A `return` ────────────────────────────
   *
   * The bare `return` closed the doubling and opened a worse hole: it also
   * skipped `Position.set`, so on a replayed range the ONLY handler left
   * writing the row was the PositionManager `Transfer` handler — and its write
   * is `newPosition()` spread with an owner, i.e. `poolId: ""`, `liquidity: 0`,
   * `isActive: false`. Measured on the live rebuild: 12 chain-8453 positions
   * (e.g. `8453_4032`) frozen as that stub, each with a CORRECT
   * `ModifyLiquidity` + `PositionTransaction` ledger behind it, and each one
   * permanent — the fee sweep filters on `poolId !== ""`
   * (feeSync-block.ts:292), so a stub is never re-read from chain either.
   *
   * So the replay now skips the accumulators it cannot reason about and RUNS
   * ON to the position block, which CAN reason about itself: `lastModifyBlock`
   * / `lastModifyLogIndex` on the row record the last ModifyLiquidity folded
   * into it, so a replayed event is skipped when the row already counted it and
   * applied when it did not. That asymmetry is not laziness — Pool, Tick and
   * the day/hour rollups are shared by every position in the pool, so no row of
   * theirs can say which events it contains, while a position's entire
   * arithmetic lives on the one row the watermark sits on.
   */
  const eventId = `${event.chainId}_${event.transaction.hash}_${event.logIndex}`;
  // The row is KEPT, not just tested for existence: it carries this event's
  // `amount0`/`amount1` as computed on the first pass, against the pool price as
  // it stood AT the event. That is the only surviving record of that price, and
  // the heal path below needs it. See AMOUNTS ON A REPLAY.
  const priorLedgerRow = await context.ModifyLiquidity.get(eventId);
  const replayed = priorLedgerRow !== undefined;
  if (replayed) {
    context.log.warn(
      `ModifyLiquidity ${eventId} has already been applied — skipping its ` +
        `running sums. This is a REPLAY: the indexer is re-processing a range it ` +
        `already committed. The pool, tick and interval accumulators are NOT ` +
        `idempotent, so re-applying them would inflate liquidity, TVL and ` +
        `txCount. The position row is reconciled against its own watermark ` +
        `below instead of being skipped.`,
    );
  }

  // --- Tick updates ---
  const lowerTickIdx = Number(event.params.tickLower);
  const upperTickIdx = Number(event.params.tickUpper);
  const amount = event.params.liquidityDelta;

  let lowerTick =
    existingLowerTick ??
    createInitialTick(
      lowerTickId,
      lowerTickIdx,
      poolId,
      BigInt(event.block.timestamp),
      BigInt(event.block.number),
      BigInt(event.chainId)
    );
  let upperTick =
    existingUpperTick ??
    createInitialTick(
      upperTickId,
      upperTickIdx,
      poolId,
      BigInt(event.block.timestamp),
      BigInt(event.block.number),
      BigInt(event.chainId)
    );

  lowerTick = {
    ...lowerTick,
    liquidityGross: lowerTick.liquidityGross + amount,
    liquidityNet: lowerTick.liquidityNet + amount,
  };
  upperTick = {
    ...upperTick,
    liquidityGross: upperTick.liquidityGross + amount,
    liquidityNet: upperTick.liquidityNet - amount,
  };

  // Save tick entities. NOT on a replay: `liquidityGross`/`liquidityNet` are
  // running sums over every position in the pool, and nothing on the tick row
  // says which events it already contains.
  if (!replayed) {
    context.Tick.set(lowerTick);
    context.Tick.set(upperTick);
  }

  // --- Pool, token, and manager updates ---
  const currTick = existingPool.tick ?? 0n;
  const currSqrtPriceX96 = existingPool.sqrtPrice ?? 0n;
  // Calculate the token amounts from the liquidity change
  const amount0Raw = getAmount0(
    event.params.tickLower,
    event.params.tickUpper,
    currTick,
    event.params.liquidityDelta,
    currSqrtPriceX96
  );
  const amount1Raw = getAmount1(
    event.params.tickLower,
    event.params.tickUpper,
    currTick,
    event.params.liquidityDelta,
    currSqrtPriceX96
  );
  /*
   * ─── AMOUNTS ON A REPLAY ──────────────────────────────────────────────────
   *
   * `currTick`/`currSqrtPriceX96` above are the POOL ROW's price, which is
   * maintained from Initialize and Swap logs rather than read per event. That is
   * deliberate and it is what Ponder does too (`apps/v4/src/index.ts:179`,
   * "log-maintained price (Initialize + Swap)"); neither indexer calls getSlot0
   * per event.
   *
   * It is correct exactly while events are processed in order, once. On a REPLAY
   * it is not: envio re-delivers a committed range WITHOUT reverting the rows it
   * wrote, so the pool row here is from AHEAD of the event being re-processed and
   * these formulas price the change at a tick that had not happened yet. A
   * deposit re-priced after the market left the range books its whole value on
   * one side — which is the `withdrawnToken0 > 0` with `depositedToken0 == 0`
   * shape, money out with no money in.
   *
   * Ponder never hits this because its store REVERTS: `revertOmnichain` /
   * `revertMultichain` (ponder/dist/esm/database/actions.js:187,216) delete every
   * reorg-table row `WHERE checkpoint > <checkpoint>` and restore the prior
   * values, so by the time a handler re-runs, `pool.tick` is the tick as of the
   * event again. Envio has no such rollback, so the correction has to be here.
   *
   * THE FIRST PASS ALREADY RECORDED THE RIGHT NUMBERS. `ModifyLiquidity` is keyed
   * on `chainId_txHash_logIndex` and carries `amount0`/`amount1` (schema.graphql:
   * 342-343) written from the pool price at the event — and it is the very row
   * whose presence raised `replayed`. So take them from it rather than recomputing
   * against a price from the future. Same sign convention: the row stores the
   * value SIGNED by liquidityDelta, exactly as this local is.
   *
   * Not an RPC and not a schema change — the data was always there, just unread.
   */
  const amount0 = priorLedgerRow
    ? priorLedgerRow.amount0
    : convertTokenToDecimal(amount0Raw, existingToken0.decimals);
  const amount1 = priorLedgerRow
    ? priorLedgerRow.amount1
    : convertTokenToDecimal(amount1Raw, existingToken1.decimals);

  // Calculate amountUSD based on token prices
  const amountUSD = amount0
    .times(existingToken0.derivedETH)
    .plus(amount1.times(existingToken1.derivedETH))
    .times(bundle.ethPriceUSD);

  // Update pool TVL and txCount
  let pool = {
    ...existingPool,
    txCount: existingPool.txCount + 1n,
    totalValueLockedToken0: existingPool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: existingPool.totalValueLockedToken1.plus(amount1),
  };
  // Only update liquidity if position is in range and tick is initialized
  if (
    pool.tick !== null &&
    pool.tick !== undefined &&
    event.params.tickLower <= pool.tick &&
    event.params.tickUpper > pool.tick
  ) {
    pool = {
      ...pool,
      liquidity: pool.liquidity + event.params.liquidityDelta,
    };
  }
  // Update token TVL and txCount
  let token0 = {
    ...existingToken0,
    txCount: existingToken0.txCount + 1n,
    totalValueLocked: existingToken0.totalValueLocked.plus(amount0),
  };
  let token1 = {
    ...existingToken1,
    txCount: existingToken1.txCount + 1n,
    totalValueLocked: existingToken1.totalValueLocked.plus(amount1),
  };
  // Store current pool TVL for later
  const currentPoolTvlETH = pool.totalValueLockedETH;
  const currentPoolTvlUSD = pool.totalValueLockedUSD;
  // After updating token TVLs, calculate ETH and USD values
  pool = {
    ...pool,
    totalValueLockedETH: pool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
  };
  pool = {
    ...pool,
    totalValueLockedUSD: sanitizeBD(
      pool.totalValueLockedETH.times(bundle.ethPriceUSD)
    ),
  };
  // Update token totalValueLockedUSD
  token0 = {
    ...token0,
    totalValueLockedUSD: token0.totalValueLocked.times(
      token0.derivedETH.times(bundle.ethPriceUSD)
    ),
  };
  token1 = {
    ...token1,
    totalValueLockedUSD: token1.totalValueLocked.times(
      token1.derivedETH.times(bundle.ethPriceUSD)
    ),
  };
  // Update PoolManager
  let poolManager = {
    ...existingPoolManager,
    txCount: existingPoolManager.txCount + 1n,
    // Reset and recalculate TVL
    totalValueLockedETH: existingPoolManager.totalValueLockedETH
      .minus(currentPoolTvlETH)
      .plus(pool.totalValueLockedETH),
  };
  poolManager = {
    ...poolManager,
    totalValueLockedUSD: poolManager.totalValueLockedETH.times(
      bundle.ethPriceUSD
    ),
  };

  // ---- interval data (day / hour snapshots) ----
  // ModifyLiquidity contributes NO volume and NO fees, only the txCount bump
  // and the price / TVL snapshot - matching
  // v4-subgraph/src/mappings/modifyLiquidity.ts:176-182, which discards every
  // return value and has no follow-up mutation block.
  const blockTimestamp = event.block.timestamp;
  // Skipped on a replay for the same reason as the ticks: every rollup here
  // bumps a `txCount` and snapshots a TVL that this event already contributed
  // to once.
  if (!replayed) {
    await Promise.all([
      updateUniswapDayData(context, poolManager, blockTimestamp),
      updatePoolDayData(context, pool, blockTimestamp),
      updatePoolHourData(context, pool, blockTimestamp),
      updateTokenDayData(context, token0, bundle.ethPriceUSD, blockTimestamp),
      updateTokenHourData(context, token0, bundle.ethPriceUSD, blockTimestamp),
      updateTokenDayData(context, token1, bundle.ethPriceUSD, blockTimestamp),
      updateTokenHourData(context, token1, bundle.ethPriceUSD, blockTimestamp),
    ]);
  }

  // Create ModifyLiquidity entity
  const modifyLiquidityId = `${event.chainId}_${event.transaction.hash}_${event.logIndex}`;
  const modifyLiquidity = {
    id: modifyLiquidityId,
    chainId: BigInt(event.chainId),
    transaction: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    pool_id: pool.id,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    // The event's sixth parameter, which this row used to drop. It is what makes
    // the fee-frame ORDINAL countable — see `saltOrdinal` below — so this write
    // is load-bearing for collected fees, not bookkeeping. Written here, before
    // the position block, and therefore visible to every LATER event of the same
    // transaction in the serial pass.
    salt: event.params.salt,
    amount: event.params.liquidityDelta,
    amount0: amount0,
    amount1: amount1,
    amountUSD: sanitizeBD(amountUSD),
    tickLower: BigInt(event.params.tickLower),
    tickUpper: BigInt(event.params.tickUpper),
    logIndex: BigInt(event.logIndex),
  };

  // Check if this is a hooked pool and update HookStats
  if (!replayed && isHookedPool && existingHookStats) {
    // Update the TVL for this hook
    context.HookStats.set({
      ...existingHookStats,
      totalValueLockedUSD: existingHookStats.totalValueLockedUSD
        .minus(currentPoolTvlUSD) // Remove old TVL
        .plus(pool.totalValueLockedETH.times(bundle.ethPriceUSD)), // Add new TVL
    });
  }

  // `ModifyLiquidity` is keyed on `chainId_txHash_logIndex` and built purely
  // from the event, so re-setting it is a no-op by construction — it is skipped
  // only because its presence is what raised `replayed` in the first place. The
  // four rows after it are accumulators and must not be re-applied.
  if (!replayed) {
    context.ModifyLiquidity.set(modifyLiquidity);
    context.PoolManager.set(poolManager);
    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
  }

  // ─── Position attribution ──────────────────────────────────────────────────
  //
  // `salt` IS the NFT tokenId (PositionManager packs it there; Ponder relies on
  // the same fact at apps/v4/src/index.ts:176). Without reading it this event is
  // position-blind and none of the position surface can exist.
  //
  // Everything below is derived from the event plus state this handler already
  // computed — no RPC. Fee columns are deliberately left at their previous
  // values: `totalFeesUncollected*` needs getFeeGrowthInside and
  // `totalFeesCollected*` needs the `feesAccrued` return value of
  // modifyLiquidity, which is in no log. Both arrive via effects later.
  //
  // ─── NFT POSITIONS ONLY: the caller MUST be the PositionManager ────────────
  //
  // `salt` is an NFT tokenId only when the PositionManager put it there. The
  // v4 position key is (owner = msg.sender, tickLower, tickUpper, salt) — see
  // the `getPositionInfo` ABI in effects/positionState.ts:65-79 — and `salt` is
  // a CALLER-SUPPLIED bytes32 with no constraint on its value
  // (effects/feesAccrued.ts:53-62). Any contract that opens a PoolManager lock
  // can therefore call modifyLiquidity with any salt it likes: hooks, custom
  // routers, vaults, and third-party position managers all do.
  //
  // Ponder filters on exactly this, as the FIRST statement of its handler, and
  // its config delivers every ModifyLiquidity unfiltered (`args: {}`), so this
  // one line is the whole guard there:
  //
  //     if (sender.toLowerCase() !== POSITION_MANAGER_ADDRESS) return;
  //         — apps/v4/src/index.ts:165
  //
  // Without it, a non-NFT salt becomes a tokenId and gets a Position row. Two
  // consequences, the second severe:
  //
  //   1. Junk rows. `Position.tokenId` is a BigInt, so it always serialises as
  //      decimal digits and always passes the backend's only defence — the
  //      `/^\d+$/` format test at
  //      backend/src/subgraph/adapters/ponder-compatible.adapter.ts:732. That
  //      filter was written for the vanilla subgraph's COMPOUND HEX ids; it is
  //      inert against this shape. So the rows reach the leaderboard as real
  //      positions, owned by whichever EOA sent the transaction.
  //
  //   2. Collision with a REAL position. The row key is `<chainId>_<tokenId>`,
  //      so a salt that is numerically equal to a live NFT id writes the SAME
  //      row. PositionManager tokenIds are a counter from 1, so the populated
  //      range is small integers — precisely what a vault indexing its
  //      positions, or any other v4 position manager running its own counter
  //      from 1, would use as a salt. The write then clobbers the genuine
  //      position's `poolId`, ticks, and running `liquidity` while KEEPING its
  //      owner and created-at, and the next sweep asks
  //      getPositionInfo(<hook pool>, PositionManager, <hook ticks>, salt),
  //      gets liquidity 0, and zeroes the real user's `amount0`/`amount1`.
  //
  // Placed AFTER the pool/token/tick/interval writes above and before the gas
  // query below: those mirror the vanilla subgraph, which counts every
  // ModifyLiquidity regardless of caller, so the return must not skip them.
  // It cannot be an Envio `eventFilters` on the indexed `sender` either — that
  // would drop the event before those writes.
  const positionManager = positionManagerFor(event.chainId);
  if (!positionManager) {
    // Refuse to attribute rather than attribute wrongly. Such a chain has no
    // fee sweep either (feeSync-block.ts:97 gates on `v4AddressesFor`), so its
    // position rows would never get uncollected fees or refreshed amounts — a
    // half-built row that reads as real is worse than no row. Warned once per
    // chain so enabling a chain without a table entry is loud, not silent.
    if (!warnedNoPositionManager.has(event.chainId)) {
      warnedNoPositionManager.add(event.chainId);
      context.log.warn(
        `No PositionManager address for chain ${event.chainId} — position ` +
          `attribution is DISABLED on this chain. Add its config.yaml ` +
          `PositionManager to POSITION_MANAGERS in src/utils/v4Addresses.ts.`,
      );
    }
    return;
  }
  // `sender` is an EIP-55 checksummed address: `address_format` defaults to
  // `checksum` (node_modules/envio/src/Config.res:663) and config.yaml does not
  // override it, which is also why initialize-handler.ts:97 lowercases.
  if (event.params.sender.toLowerCase() !== positionManager) return;

  const fullTxGasCostETH = gasCostEth(
    event.transaction.gasUsed,
    event.transaction.effectiveGasPrice,
    event.transaction.l1Fee,
  );

  /*
   * Gas is a property of the TRANSACTION, so it is charged exactly once no
   * matter how many positions that transaction touches.
   *
   * Ponder does this by counting rows of the same tx with a STRICTLY LOWER log
   * index and charging the full amount only when there are none, so the cost
   * lands on the lowest-logIndex row-writing event and nowhere else
   * (apps/v4/src/index.ts:270-282). Strictly-lower is what makes it replay-safe:
   * an event's own row, recreated on a replay, has the same logIndex and so can
   * never disqualify itself.
   *
   * The port previously added the full transaction gas to EVERY position it
   * touched, so a router batching n positions overstated gas n-fold — and
   * `totalGasCostETH` feeds net-of-cost performance, so that inflates a real
   * customer-visible figure.
   */
  const priorRowsThisTx = await context.PositionTransaction.getWhere({
    txHash: { _eq: event.transaction.hash },
  });
  const isGasBearer = !priorRowsThisTx.some(
    (r) => r.chainId === BigInt(event.chainId) && r.logIndex < BigInt(event.logIndex),
  );
  const txGasCostETH = isGasBearer ? fullTxGasCostETH : ZERO_BD;

  const tokenId = tokenIdFromSalt(event.params.salt);
  if (tokenId !== undefined) {
    const pid = positionId(event.chainId, tokenId);
    const existing =
      (await context.Position.get(pid)) ??
      newPosition({
        id: pid,
        chainId: BigInt(event.chainId),
        tokenId,
        // A ModifyLiquidity can precede the mint Transfer, so ownership is
        // provisional here and the Transfer handler corrects it.
        owner: event.transaction.from || "NONE",
        origin: event.transaction.from || "NONE",
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
      });

    /*
     * THE REPLAY RECONCILIATION, and the whole reason the guard above is a flag
     * rather than a `return`.
     *
     * `lastModifyBlock`/`lastModifyLogIndex` is the (block, logIndex) of the
     * last ModifyLiquidity folded into THIS row, written nowhere else — not by
     * the Transfer handler, not by the fee sweep. Events reach a chain's
     * handlers in (block, logIndex) order, so the pair is a high-water mark and
     * the comparison is exact:
     *
     *   at or below it  ⇒ this event is already inside these sums. Skip, or the
     *                     doubling the guard exists to prevent comes back.
     *   above it        ⇒ this event is NOT in them, whatever the ledger rows
     *                     say. Apply it. This is the healing case, and it is
     *                     what a stub row is: `newPosition()` leaves the
     *                     watermark at (0, 0), so every replayed event is still
     *                     owed and they re-apply in order onto zeroed sums.
     *
     * The stub cannot double count because the watermark and the sums are
     * written in the SAME `Position.set` below — a row at (0, 0) has had no
     * ModifyLiquidity arithmetic applied to it at all, by construction.
     *
     * Consulted only on a replay. On the normal path the ledger row does not
     * exist yet, so the event is new by definition and the comparison could only
     * ever mis-skip a genuine event if two events shared a (block, logIndex).
     */
    if (
      replayed &&
      (existing.lastModifyBlock > BigInt(event.block.number) ||
        (existing.lastModifyBlock === BigInt(event.block.number) &&
          existing.lastModifyLogIndex >= BigInt(event.logIndex)))
    ) {
      return;
    }

    const delta = event.params.liquidityDelta;
    const isAdd = delta > 0n;
    const rawNextLiquidity = existing.liquidity + delta;

    // On-chain liquidity cannot go negative; a negative running sum means a
    // missed or out-of-order event. Ponder clamps to zero and WARNS rather than
    // storing the negative (apps/v4/src/index.ts:192-198) — storing it would
    // propagate into `isActive`, the amount math and every aggregate below.
    if (rawNextLiquidity < 0n) {
      context.log.warn(
        `ModifyLiquidity: negative liquidity for position ${tokenId} ` +
          `(prev=${existing.liquidity} delta=${delta}) — clamping to 0`,
      );
    }
    const nextLiquidity = rawNextLiquidity < 0n ? 0n : rawNextLiquidity;

    // Tick math is meaningless at the edges of the representable domain, where
    // it returns numbers that are enormous but physically absurd. Ponder gates
    // every amount on this and so does the sweep.
    const degenerate = isDegenerate(pool.tick ?? 0n, pool.sqrtPrice ?? 0n);

    // EXACT collected fees, from the call trace.
    //
    // `feesAccrued` is a RETURN VALUE of PoolManager.modifyLiquidity and appears
    // in no event — v4 has no Collect event and this event carries no fee field
    // — so a trace is the only foolproof source. Ported from Ponder's
    // core/fees-trace.ts, and the effect returns every salt in the transaction
    // at once so a batched multi-position tx costs one trace.
    //
    /*
     * THE ONLY REMAINING TRACE SKIP, and every conjunct in it is a PROOF rather
     * than a heuristic.
     *
     *     (hadPosition && existing.liquidity > 0n) || storeLiquidityDesynced
     *
     * `hadPosition && existing.liquidity > 0n` is Ponder's provably-zero skip
     * (apps/v4/src/index.ts:222), and it is what makes this whole change
     * affordable: a MINT has no prior position and therefore no prior liquidity,
     * so `feesAccrued` on it is provably (0, 0) — there is nothing for a trace
     * to discover. Mints are the bulk of ModifyLiquidity events, and this clause
     * is what keeps the positive-delta majority off the trace path entirely.
     * Measured over the whole history of chain 43114, the widened gate adds
     * 7,381 traces, at most 1.6x, because a trace is per TRANSACTION and cached.
     *
     * `!degenerate` IS DELIBERATELY NOT HERE, and that is a change. A degenerate
     * pool is one parked at the edge of the representable tick domain, where the
     * tick FORMULAS produce astronomical nonsense — so its computed amounts are
     * zeroed, below and in the sweep, and they stay zeroed. But `feesAccrued` is
     * not computed from ticks: it is a RETURN VALUE read out of the call trace,
     * and a degenerate pool's collected fee is real money that really moved.
     * Zeroing it because the pool's PRICE is unusable confuses two different
     * quantities.
     *
     * Ponder's `feeGrowthChanged` third conjunct is gone entirely — see
     * `shouldTraceFees` in utils/feeGate.ts. In one line: it compares a
     * POOL-level `feeGrowthInside` sampled at END OF BLOCK against a fee
     * determined by the POSITION's own MID-TRANSACTION checkpoint, and those
     * diverge permanently at mint (43114_1356), so it can read false for a
     * position's entire life.
     */
    const hadPosition = existing.poolId !== "";

    /*
     * A DETECTABLE DESYNC, which must trace even though the skip above says it
     * cannot have fees.
     *
     * The clamp at the top of this block exists because a negative running
     * liquidity means a missed or out-of-order event. When that has happened,
     * `existing.liquidity` is 0 while the chain's position still holds
     * liquidity, and the skip would then "prove" a settlement has no fees using
     * a number already known to be wrong.
     *
     * `existing.liquidity === 0n && liquidityDelta <= 0n` is the desync escape
     * hatch. For `< 0n` the proof is direct: the PoolManager cannot remove
     * liquidity from a position that has none; it reverts. So observing it is
     * proof the STORE is behind, not proof about the position.
     *
     * `== 0n` IS INCLUDED, AND NARROWING IT BACK TO `< 0n` IS A CORRECTNESS
     * REGRESSION, not a tightening. A stored zero that is already known to be
     * wrong cannot prove anything about a pure collect either, and pure collects
     * are 69.9% of fee-bearing settlements. Pinned in
     * `feeFramePairing.test.ts`. Trace both.
     */
    const gateCanPass = traceGateCanPass({
      hadPosition,
      storedLiquidity: existing.liquidity,
      liquidityDelta: delta,
    });

    /*
     * THE SAME CALL THE PRELOAD BLOCK ABOVE ALREADY MADE, with the same
     * `feeGateEvent`, so this normally resolves from the effect output dict
     * without touching the network (`LoadManager.res.mjs:80`). It stays here
     * rather than being read out of a variable so that the real path remains
     * correct on its own — a preload pass that was skipped, or whose throw was
     * swallowed, costs latency here and nothing else.
     *
     * The predicate lives in `feeGate` (utils/feeGate.ts) and is NOT repeated
     * here. Two copies is the specific failure this refactor exists to prevent:
     * a preload copy that drifts from the real one either warms an input nobody
     * asks for or, worse, misses the one that is asked for and puts a full RPC
     * round trip back inside the serial loop.
     *
     * Within this branch the gate reduces to `!degenerate` — the caller is
     * already known to be the PositionManager and `tokenId` is already known to
     * exist — which is exactly where Ponder has it
     * (apps/v4/src/index.ts:211-212), and deliberately NOT on `gateCanPass`.
     * Gating the READ on `gateCanPass` silently lost fees: a mint has
     * `hadPosition === false`, so the read was skipped and
     * `feeGrowthInside0/1LastX128` kept `newPosition()`'s default of 0n, which
     * is indistinguishable from the genuine (0, 0) that a cleared tick pair
     * reports on the eventual close. Measured on Avalanche tokenId 1097 and
     * Arbitrum tokenIds 268 and 771.
     *
     * WHAT THIS READ IS STILL FOR, now that it no longer gates the trace. It
     * feeds `feeGrowthInside0/1LastX128` on the Position row, which the schema
     * exposes and the head sweep diffs against to value UNCOLLECTED fees. What
     * it must never again do is decide whether a COLLECTED fee gets measured:
     * it is a pool-level, end-of-block number, and the fee it was being used to
     * predict is set by the position's own mid-transaction checkpoint.
     */
    const fgNow = await readFeeGrowthInside(context, feeGateEvent);

    /*
     * THE READ SURVIVES; THE COMPARISON DOES NOT. `feeGrowthChanged` used to be
     * derived here and fed to `shouldTraceFees`. It is gone: comparing this
     * POOL-level, END-OF-BLOCK read against the POSITION's own MID-TRANSACTION
     * checkpoint is unsound in both directions, and it silently suppressed the
     * trace for 750 of the 1,167 wrong Avalanche positions.
     *
     * `fgNow` itself is still needed, for the two baseline columns below.
     */
    // Re-baseline to what the pool reports now, so the next event's comparison
    // is against this settle. Ponder advances this even when the trace fails,
    // so accounting stays consistent and only that one collect is under-counted.
    const fg0Last = fgNow?.ok ? fgNow.feeGrowthInside0X128 : existing.feeGrowthInside0LastX128;
    const fg1Last = fgNow?.ok ? fgNow.feeGrowthInside1X128 : existing.feeGrowthInside1LastX128;

    let settled0 = ZERO_BD;
    let settled1 = ZERO_BD;
    /*
     * The gate is now `gateCanPass` alone — the full argument for why the two
     * heuristics that used to guard it are UNSOUND rather than merely
     * conservative is on `shouldTraceFees` in utils/feeGate.ts.
     */
    if (shouldTraceFees({ gateCanPass })) {
      const [fees, modifyRowsThisTx] = await Promise.all([
        context.effect(getFeesAccrued, {
          txHash: event.transaction.hash,
          poolManager: chainConfig.poolManagerAddress,
        }),
        // Warmed by the preload block above, so this resolves from the
        // in-memory filter index rather than a SELECT in the serial loop.
        context.ModifyLiquidity.getWhere({ transaction: { _eq: event.transaction.hash } }),
      ]);

      /*
       * ORDINAL PAIRING. THE defect this change exists for.
       *
       * A settlement emits TWO ModifyLiquidity events for the SAME salt in one
       * transaction — the first carrying all the fees with `liquidityDelta == 0`,
       * the second carrying (0, 0) with the real delta. The old
       * `[...fees].reverse().find(salt)` picked the LAST, i.e. the zero, in
       * 1,163 of 2,087 measured cases. Flipping it to first-wins is NOT the fix:
       * with the gate widened both events trace, and first-wins would attribute
       * the same fee TWICE.
       *
       * So the pairing is by per-salt ORDINAL, and the ordinal is derived from
       * committed facts rather than a counter: how many ModifyLiquidity rows of
       * this transaction carry this salt and a STRICTLY LOWER log index. The
       * k-th same-salt LOG is the k-th same-salt call FRAME — verified on all
       * 2,062 Avalanche settlement transactions, 2062/2062, matching on
       * (tickLower, tickUpper, liquidityDelta, salt).
       *
       * Why strictly-lower and not a counter, and why the entity rather than the
       * PositionTransaction rows already fetched for gas: see `saltOrdinal` in
       * utils/feeFrames.ts. The short version is that the entity is written for
       * EVERY ModifyLiquidity, whatever the caller and whatever it settled,
       * which is exactly the set the trace's frame list contains — while a
       * PositionTransaction row is written only when something was settled, so
       * counting those would miscount a zero-fee first frame and hand its
       * successor the WRONG frame.
       */
      const frameKey = {
        chainId: event.chainId,
        salt: event.params.salt,
        logIndex: event.logIndex,
        tickLower: event.params.tickLower,
        tickUpper: event.params.tickUpper,
        liquidityDelta: delta,
      };
      const ordinal = saltOrdinal(modifyRowsThisTx, frameKey);
      const pick = pickFeeFrame(fees, frameKey, ordinal);

      if (pick.status === "matched") {
        settled0 = convertTokenToDecimal(pick.frame.amount0, token0.decimals);
        settled1 = convertTokenToDecimal(pick.frame.amount1, token1.decimals);
      } else if (pick.status === "mismatched") {
        /*
         * LOUD, because it is the only way the ordinal can be wrong and it is
         * silent otherwise. The frame at this ordinal describes a different
         * call, which means the log sequence this indexer saw and the frame
         * sequence in the trace have drifted — a pool skipped by
         * `chainConfig.poolsToSkip`, or one with no row yet, writes no
         * ModifyLiquidity entity while its call frame is still in the trace.
         * Record ZERO rather than a frame that is somebody else's money:
         * under-reporting is recoverable, double counting is not.
         */
        context.log.error(
          `Fee frame ordinal mismatch on chain ${event.chainId} tx ` +
            `${event.transaction.hash} logIndex ${event.logIndex}: frame ` +
            `${ordinal} for salt ${tokenId} describes ` +
            `(${pick.frame.tickLower}, ${pick.frame.tickUpper}, ` +
            `${pick.frame.liquidityDelta}) but the event is ` +
            `(${event.params.tickLower}, ${event.params.tickUpper}, ${delta}) — ` +
            `recording 0 collected fees for this event rather than risk ` +
            `attributing another position's fee.`,
        );
      } else {
        // NOT an error. No frame at this ordinal is the ordinary shape of a
        // degraded trace (the effect returns [] and warns on its own), of a
        // transaction whose salt no frame carries, and of a settlement with
        // more same-salt logs than frames. Zero is the right answer and the
        // handler has nothing to add at warn level.
        context.log.debug(
          `No fee frame at ordinal ${ordinal} for salt ${tokenId} in tx ` +
            `${event.transaction.hash} (${fees.length} frames) — 0 collected fees`,
        );
      }
    }

    /*
     * The event amounts AS THE POSITION SURFACE SEES THEM — zeroed on a
     * degenerate pool.
     *
     * Ponder gates its event amounts on `degenerate` (apps/v4/src/index.ts:243-244)
     * and those feed BOTH the cashflow aggregates and the ledger row amounts, so
     * a pool parked at the domain edge contributes zeros rather than the
     * astronomical artifact the tick formulas produce there.
     *
     * A SEPARATE pair rather than reusing `amount0`/`amount1` directly, because
     * those also feed this handler's vanilla-subgraph parity surface — pool and
     * token volume, the ModifyLiquidity entity, the USD figures — and the
     * subgraph counts every ModifyLiquidity unguarded. Ponder's handler is
     * position-only, so it can guard in one place; this one cannot.
     *
     * Observed on Avalanche tokenId 239: pool 0x88170bcf… sits at tick -887272
     * (MIN_TICK) with sqrtPrice 4295128740 (MIN_SQRT_RATIO+1). Both indexers
     * already agreed `isPriceable: false`, but Ponder's DEPOSIT row reads
     * amount0 = 0 where this port read 6.753059.
     */
    /*
     * UNCONDITIONAL, and an `&& !replayed` conjunct here was tried and REVERTED.
     *
     * The tempting argument is that a replayed `amount0` is the first pass's own
     * value and was already guarded, so guarding again against a stale-ahead
     * `degenerate` could zero a number measured on a healthy pool. THE PREMISE IS
     * FALSE. The ledger row is written from the UNGUARDED local — `amount0:
     * amount0` at the ModifyLiquidity literal above — and the guard is applied
     * only to this separate pair, exactly as the comment above says it
     * deliberately does. So on a degenerate pool the row holds the astronomical
     * artifact while the Position row correctly holds 0, and skipping the guard
     * on a replay hands that artifact straight back: measured 6.753059 into
     * `depositedToken0` on a row simultaneously stamped `isPriceable: false` and
     * `amount0: 0`, against 0 on the first pass.
     *
     * `degenerate` is a property of the POOL, not of the pass. The substitution
     * above is what makes the replay correct — `amount0` is now the event-time
     * value instead of a stale-ahead recomputation — and this guard stays on top
     * of it unchanged. Ponder computes one guarded value and feeds it to both the
     * aggregates and the ledger row (`apps/v4/src/index.ts:244`); this port split
     * them on purpose, so the split must be respected on the replay path too.
     */
    const posAmount0 = degenerate ? ZERO_BD : amount0;
    const posAmount1 = degenerate ? ZERO_BD : amount1;

    // Does this event produce a PositionTransaction row at all? Ponder's
    // `willWriteRow`, and the condition that gates gas below.
    const willWriteRow = delta !== 0n || settled0.gt(ZERO_BD) || settled1.gt(ZERO_BD);

    // `amount0`/`amount1` above are SIGNED by liquidityDelta — negative on a
    // withdraw. Cashflow aggregates want magnitudes on the matching side, which
    // is why each branch takes only one pair.
    const nextPosition = {
      ...existing,
      poolId: event.params.id,
      tickLower: BigInt(event.params.tickLower),
      tickUpper: BigInt(event.params.tickUpper),
      liquidity: nextLiquidity,
      isActive: nextLiquidity > 0n,

      depositedToken0: isAdd
        ? existing.depositedToken0.plus(posAmount0)
        : existing.depositedToken0,
      depositedToken1: isAdd
        ? existing.depositedToken1.plus(posAmount1)
        : existing.depositedToken1,
      withdrawnToken0: isAdd
        ? existing.withdrawnToken0
        : existing.withdrawnToken0.minus(posAmount0),
      withdrawnToken1: isAdd
        ? existing.withdrawnToken1
        : existing.withdrawnToken1.minus(posAmount1),

      // Recomputed from the post-change liquidity against the pool's current
      // tick — the whole reason this needs no getSlot0. Zeroed on a degenerate
      // pool, where the formulas produce astronomical nonsense, and the position
      // is flagged unpriceable so no consumer treats the zero as a valuation.
      ...(degenerate
        ? { amount0: ZERO_BD, amount1: ZERO_BD }
        : currentAmounts({
            tickLower: BigInt(event.params.tickLower),
            tickUpper: BigInt(event.params.tickUpper),
            liquidity: nextLiquidity,
            pool: { tick: pool.tick ?? 0n, sqrtPriceX96: pool.sqrtPrice ?? 0n },
            decimals0: token0.decimals,
            decimals1: token1.decimals,
          })),
      isPriceable: !degenerate,

      // Stamped on the FIRST transition to zero and preserved thereafter, and
      // cleared when liquidity returns. Ponder's rule exactly
      // (apps/v4/src/index.ts:290-296): re-stamping on every later zero-delta
      // event, as the port did, keeps moving a position's close time forward
      // and makes any holding-period derived from it wrong.
      closedAtTimestamp:
        nextLiquidity > 0n
          ? undefined
          : !existing.isActive && existing.closedAtTimestamp !== undefined
            ? existing.closedAtTimestamp
            : BigInt(event.block.timestamp),

      // The settle baseline for the next event's trace-skip comparison.
      feeGrowthInside0LastX128: fg0Last,
      feeGrowthInside1LastX128: fg1Last,

      totalFeesCollected0: existing.totalFeesCollected0.plus(settled0),
      totalFeesCollected1: existing.totalFeesCollected1.plus(settled1),
      // Just settled ⇒ nothing outstanding. The sweep refreshes it on its own
      // cadence; Ponder does exactly this (index.ts:318, "just settled → 0").
      totalFeesUncollected0: ZERO_BD,
      totalFeesUncollected1: ZERO_BD,

      /*
       * Only charged when this event actually writes a ledger row.
       *
       * Ponder computes gas inside `if (willWriteRow)`, where
       * `willWriteRow = liquidityDelta !== 0n || settled0 > 0 || settled1 > 0`
       * (apps/v4/src/index.ts:261-282). A zero-delta ModifyLiquidity that
       * settles nothing — a collect on a position with nothing accrued — writes
       * no row there and is charged no gas.
       *
       * This port charged it unconditionally, so such a no-op inflated
       * `totalGasCostETH` by a whole transaction's gas with no ledger row to
       * account for it: measured at 4-31% over on 5 of 223 Avalanche positions,
       * and it broke the invariant that the aggregate equals the sum of the
       * position's own rows. `totalGasCostETH` feeds net-of-cost performance,
       * so that is a customer-visible figure.
       */
      totalGasCostETH: willWriteRow
        ? existing.totalGasCostETH.plus(txGasCostETH)
        : existing.totalGasCostETH,

      // A real position change — the backend's change feed should see this.
      // `feesUpdatedAtBlock` is untouched; only the fee sweep owns it.
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTimestamp: BigInt(event.block.timestamp),

      // Stamped in the same write as the sums it certifies: after this row
      // lands, this event IS in `liquidity`, the cashflow aggregates and the
      // gas total, and the reconciliation above will say so on any replay.
      lastModifyBlock: BigInt(event.block.number),
      lastModifyLogIndex: BigInt(event.logIndex),
    };
    context.Position.set(nextPosition);

    // COLLECT_FEES carries the traced fee amounts, so it can only be written now
    // that the trace has returned. A pure collect in v4 is a ModifyLiquidity
    // with liquidityDelta == 0, and Ponder keys on the same condition.
    if (settled0.gt(ZERO_BD) || settled1.gt(ZERO_BD)) {
      context.PositionTransaction.set({
        id: positionTxId(
          event.chainId,
          event.transaction.hash,
          event.logIndex,
          "COLLECT_FEES",
        ),
        chainId: BigInt(event.chainId),
        position_id: pid,
        tokenId,
        txHash: event.transaction.hash,
        logIndex: BigInt(event.logIndex),
        type: "COLLECT_FEES",
        amount0: settled0,
        amount1: settled1,
        // Gas only when this IS the whole transaction's purpose. A
        // withdraw-plus-fees puts it on the WITHDRAW row instead, so one
        // transaction never contributes gas twice.
        gasCostETH: delta === 0n ? txGasCostETH : ZERO_BD,
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        sender: event.transaction.from || "NONE",
      });
    }

    if (delta !== 0n) {
      const type = isAdd ? "DEPOSIT" : "WITHDRAW";
      context.PositionTransaction.set({
        id: positionTxId(event.chainId, event.transaction.hash, event.logIndex, type),
        chainId: BigInt(event.chainId),
        position_id: pid,
        tokenId,
        txHash: event.transaction.hash,
        logIndex: BigInt(event.logIndex),
        type,
        /*
         * MAGNITUDES, not the signed event amounts.
         *
         * Ponder writes `toHuman(isAdd ? eventAmt0 : -eventAmt0, dec0)`
         * (apps/v4/src/index.ts:344-345), so a WITHDRAW row's amounts are
         * POSITIVE there. `amount0`/`amount1` here are signed by
         * `liquidityDelta` and are negative on a withdraw, so they need the same
         * negation — the position aggregates already do it, via
         * `withdrawnToken0.minus(amount0)`.
         *
         * This is not cosmetic. The backend serves this column through to the
         * customer with the sign intact, so leaving it signed would flip every
         * withdraw amount negative the moment positions are read from Envio
         * instead of Ponder — 164 of 164 rows on Avalanche, identical in
         * magnitude and wrong in sign.
         */
        amount0: isAdd ? posAmount0 : ZERO_BD.minus(posAmount0),
        amount1: isAdd ? posAmount1 : ZERO_BD.minus(posAmount1),
        // Gas lands on this row. A pure collect (delta == 0) carries it on its
        // own COLLECT_FEES row instead, so it is never counted twice for one
        // transaction — the backend de-dupes per txHash when rendering.
        gasCostETH: txGasCostETH,
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        sender: event.transaction.from || "NONE",
      });
    }
  }
});
