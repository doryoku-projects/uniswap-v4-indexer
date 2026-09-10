/*
 * Position liquidity + fee tracking. Ported from the Ponder v4 position
 * indexer, minus its dependency on debug_traceTransaction.
 *
 * Two entry points:
 *
 *   trackPositionFees()  — called from the ModifyLiquidity handler. Maintains
 *     the Position row (liquidity, lifecycle, cashflows, EXACT collected fees)
 *     and writes PositionTransaction rows.
 *
 *   indexer.onBlock "FeeSync" — live-only refresh of uncollected fees and
 *     current amounts, the equivalent of Ponder's Multicall3 FeeSync tick.
 *
 * Registration note: Envio maps one handler per (contract, event), so this is a
 * plain function invoked by src/handlers/modifyLiquidity-handler.ts rather than
 * a second `indexer.onEvent` for ModifyLiquidity. It reuses the pool and token
 * rows that handler already loaded, so it adds no extra entity reads.
 */
import { indexer } from "envio";
import type { Position } from "envio";
import { getAmount0, getAmount1 } from "../utils/liquidityMath/liquidityAmounts";
import {
  calculateUncollectedFees,
  collectedFees,
  isDegenerate,
  isInRange,
  saltOf,
  toHuman,
} from "../utils/positionMath";
import {
  POSITION_MANAGER_BY_CHAIN,
  RPC_ENV_BY_CHAIN,
  STATE_VIEW_BY_CHAIN,
  feeTrackingEnabled,
  rpcUrlFor,
} from "../utils/positionAddresses";
import { getPositionInfoAt, refreshPositionsBatch } from "../utils/stateView";

/** Chains already warned about missing fee-tracking config (once each). */
const warnedNoFeeTracking = new Set<number>();

/**
 * Which log index inside the CURRENT transaction gets charged the tx gas.
 *
 * A transaction's logs are contiguous in logIndex, so the indexer processes all
 * of a tx's events consecutively and a single-entry cache is sufficient (the
 * same trick Ponder uses for its per-tx trace cache).
 *
 * This replaces a `getWhere({ txHash })` per event. That query was correct but
 * ruinous at backfill scale: it is an awaited Postgres round trip in the strictly
 * sequential pass, and envio's in-memory filter indexes are rebuilt by scanning
 * the whole change set per new filter, making it quadratic in the number of
 * position events per batch. Over 57M blocks that is hours of pure latency.
 *
 * Replay-safe: on a reorg the row is rolled back and the tx is re-processed, at
 * which point the remembered logIndex still matches the first row-writing event,
 * so gas lands exactly once again.
 */
let gasTxHash: string | null = null;
let gasLogIndex: bigint | null = null;

/**
 * TokenIds already settled in the block currently being processed.
 *
 * Needed because getPositionInfo returns END-OF-BLOCK state. When a tokenId is
 * modified more than once in a block, the contract's liquidity already includes
 * the later deltas, so comparing it against this event's running total
 * legitimately differs. Measured on this dataset: 916 blocks contain a repeated
 * tokenId, so an unconditional comparison cries wolf on roughly a tenth of all
 * position events. Fees are unaffected either way — they use the pre-event
 * liquidity, never the end-of-block value.
 */
let driftBlock = -1;
let driftSeen = new Set<string>();

/**
 * FeeSync cadence per chain, in blocks — roughly one hour each.
 *
 * Overridable per chain with `ENVIO_FEE_SYNC_INTERVAL_<chainId>`, so the
 * refresh rate can be tuned (or driven low to verify the path) without a code
 * change. Unlike Ponder, where this value feeds the build fingerprint and
 * changing it crash-loops the indexer, here it only affects handler
 * registration.
 */
function feeSyncInterval(chainId: number): number | undefined {
  const override = process.env[`ENVIO_FEE_SYNC_INTERVAL_${chainId}`];
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return FEE_SYNC_INTERVAL_BLOCKS[chainId];
}

const FEE_SYNC_INTERVAL_BLOCKS: Record<number, number> = {
  1: 300, // ~12s blocks
  10: 900, // ~2s — matches ponder/networks.json
  4663: 36000, // ~100ms
  42161: 8000, // ~0.25s
  // ~2s blocks -> a tick every ~40 min. With Multicall3 batching a full pass
  // over ~2,600 active positions is ~26 eth_calls, seconds rather than the
  // 43 min the per-position version needed.
  43114: 1200,
};

/**
 * Positions per Multicall3 batch. Each batch is ONE eth_call carrying
 * 2 reads per position plus one deduplicated getSlot0 per distinct pool, so 100
 * positions is roughly 250 sub-calls — large enough to matter, small enough to
 * stay well inside an eth_call's gas and calldata limits.
 */
const POSITIONS_PER_BATCH = 100;

/** Runaway guard only. FeeSync refreshes every active position each tick (as
 *  Ponder does); this caps a pathological case, stalest-first, and warns. */
const MAX_REFRESH_PER_TICK = 20_000;

/** Codegen'd entities are deeply readonly; FeeSync builds its patch field by
 *  field, so it needs a mutable partial to accumulate into. */
type PositionUpdate = { -readonly [K in keyof Position]?: Position[K] };

/** One position's live on-chain state, as returned by refreshPositionsBatch. */
type LiveState = {
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  feeGrowthInside0X128: string;
  feeGrowthInside1X128: string;
  feeGrowthInside0LastX128: string;
  feeGrowthInside1LastX128: string;
};

/**
 * Field defaults for a Position row created by a path that knows nothing about
 * liquidity — i.e. PositionManager.Transfer on mint, which can be indexed
 * before (or without) the matching PoolManager.ModifyLiquidity.
 */
export function positionDefaults(): Omit<
  Position,
  "id" | "chainId" | "tokenId" | "owner" | "origin" | "createdAtTimestamp"
> {
  return {
    // "" rather than undefined: `poolId` is non-null so the backend's
    // unguarded `raw.poolId.toLowerCase()` cannot throw on a position minted
    // before its first ModifyLiquidity.
    poolId: "",
    tickLower: undefined,
    tickUpper: undefined,
    liquidity: 0n,
    isActive: false,
    isPriceable: true,
    createdAtBlockNumber: 0n,
    closedAtTimestamp: undefined,
    depositedToken0: 0,
    depositedToken1: 0,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 0,
    totalFeesCollected1: 0,
    totalFeesUncollected0: 0,
    totalFeesUncollected1: 0,
    amount0: 0,
    amount1: 0,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    // No on-chain read has happened for this row yet, so nothing may be settled
    // against its zero baseline.
    feeBaselineValid: false,
    totalGasCostETH: 0,
    updatedAtBlock: 0n,
    updatedAtTimestamp: 0n,
  };
}

interface TrackArgs {
  event: {
    chainId: number;
    params: {
      id: string;
      sender: string;
      tickLower: bigint;
      tickUpper: bigint;
      liquidityDelta: bigint;
      salt: string;
    };
    block: { number: number; timestamp: number; hash: string };
    transaction: {
      hash: string;
      from?: string | undefined;
      gasUsed?: bigint | undefined;
      effectiveGasPrice?: bigint | undefined;
    };
    logIndex: number;
  };
  context: any;
  /** Namespaced pool id, `<chainId>_<bytes32>`. */
  poolId: string;
  /** Pool tick and price maintained from Initialize + Swap logs. */
  poolTick: bigint;
  poolSqrtPriceX96: bigint;
  token0Decimals: bigint;
  token1Decimals: bigint;
}

/**
 * Maintain a Position and its PositionTransaction rows for one ModifyLiquidity.
 *
 * Collected fees come from the contract's own `feeGrowthInsideLast`, read once
 * per modify at that block. v4 settles accrued fees on EVERY modifyLiquidity,
 * so a delta against the baseline we stored at the previous settle is exactly
 * the `feesAccrued` the trace would have reported.
 */
export async function trackPositionFees(args: TrackArgs): Promise<void> {
  const {
    event,
    context,
    poolId,
    poolTick,
    poolSqrtPriceX96,
    token0Decimals,
    token1Decimals,
  } = args;

  const chainId = event.chainId;
  const positionManager = POSITION_MANAGER_BY_CHAIN[chainId];
  // Only PositionManager-owned liquidity is an NFT position. Direct PoolManager
  // liquidity (routers, hooks, JIT bots) has no tokenId and is out of scope —
  // on Robinhood that is ~58% of all ModifyLiquidity events.
  if (!positionManager || event.params.sender.toLowerCase() !== positionManager) {
    return;
  }

  const tokenId = BigInt(event.params.salt);
  const id = `${chainId}_${tokenId}`;
  const tickLower = event.params.tickLower;
  const tickUpper = event.params.tickUpper;
  const degenerate = isDegenerate(poolTick, poolSqrtPriceX96);

  const existing: Position | undefined = await context.Position.get(id);
  const prevLiquidity = existing?.liquidity ?? 0n;

  // Fire the on-chain read in BOTH passes: during preload it warms the effect
  // cache (and batches with every other position in the block range), during
  // the sequential pass it is a cache hit. Skipped on degenerate pools, whose
  // amounts are discarded anyway.
  let info: {
    liquidity: string;
    feeGrowthInside0LastX128: string;
    feeGrowthInside1LastX128: string;
  } | null = null;
  // Say so ONCE per chain when fees cannot be computed. Without this a missing
  // RPC url silently writes zero collected fees for an entire backfill, which
  // looks like real data and is only caught by comparing against Ponder.
  if (!feeTrackingEnabled(chainId) && !warnedNoFeeTracking.has(chainId)) {
    warnedNoFeeTracking.add(chainId);
    context.log.warn(
      "fee tracking DISABLED for this chain — collected fees will be 0. " +
        "Needs a verified StateView address in positionAddresses.ts AND an archive RPC url.",
      {
        chainId,
        hasStateView: Boolean(STATE_VIEW_BY_CHAIN[chainId]),
        hasRpcUrl: Boolean(rpcUrlFor(chainId)),
        expectedRpcEnvVar: RPC_ENV_BY_CHAIN[chainId] ?? "(none mapped)",
      },
    );
  }
  if (!degenerate && feeTrackingEnabled(chainId)) {
    info = await context.effect(getPositionInfoAt, {
      blockNumber: event.block.number,
      blockHash: event.block.hash,
      poolId: event.params.id,
      owner: positionManager,
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      salt: saltOf(tokenId),
    });
  }

  if (context.isPreload) return;

  // ── Liquidity + lifecycle ─────────────────────────────────────────────────
  // Computed before the fee block because the fee block cross-checks it against
  // the contract's own post-event liquidity.
  const newLiquidity = prevLiquidity + event.params.liquidityDelta;
  if (newLiquidity < 0n) {
    context.log.warn("negative position liquidity; clamping to 0", {
      tokenId: tokenId.toString(),
      prevLiquidity: prevLiquidity.toString(),
      delta: event.params.liquidityDelta.toString(),
    });
  }
  const liquidity = newLiquidity < 0n ? 0n : newLiquidity;
  const isAdd = event.params.liquidityDelta > 0n;
  const isActive = liquidity > 0n;

  // ── Collected fees ────────────────────────────────────────────────────────
  //
  // A fee is booked ONLY when the stored baseline is known-good. If a previous
  // read failed, or the pool was degenerate, or this chain had no RPC at the
  // time, the baseline is stale or still 0 — and diffing against it would not
  // "catch up the missed fee", it would settle the missed growth at the CURRENT
  // liquidity. With liquidity since grown 100x that overstates the fee 100x, and
  // against a 0 baseline it books the range's entire historical fee growth.
  //
  // So an unverified baseline is re-initialised from the successful read and
  // books nothing. That under-counts by the fee accrued while tracking was off,
  // which is the safe direction: Ponder likewise chooses to under-count rather
  // than risk the astronomical-value corruption this indexer exists to avoid.
  let fg0Last = existing?.feeGrowthInside0LastX128 ?? 0n;
  let fg1Last = existing?.feeGrowthInside1LastX128 ?? 0n;
  let baselineValid = existing?.feeBaselineValid ?? false;
  let settled0 = 0;
  let settled1 = 0;
  if (info) {
    const fgNew0 = BigInt(info.feeGrowthInside0LastX128);
    const fgNew1 = BigInt(info.feeGrowthInside1LastX128);
    if (baselineValid) {
      const fees = collectedFees(fgNew0, fgNew1, fg0Last, fg1Last, prevLiquidity);
      settled0 = toHuman(fees.amount0, token0Decimals);
      settled1 = toHuman(fees.amount1, token1Decimals);
    } else if (prevLiquidity > 0n) {
      context.log.warn(
        "initialising fee baseline on a position that already held liquidity — " +
          "fees accrued before this point are not counted",
        { chainId, tokenId: tokenId.toString(), block: event.block.number },
      );
    }
    // Advance the baseline even when nothing was booked, so the NEXT settle
    // diffs against a verified value.
    fg0Last = fgNew0;
    fg1Last = fgNew1;
    baselineValid = true;

    // Drift check. getPositionInfo also returns the contract's own liquidity,
    // so comparing it against the event-derived figure is free and catches a
    // missed event, a double-applied delta, or a truncated start block.
    //
    // Only valid on the FIRST modify of a tokenId in a block: the read is
    // end-of-block, so any later modify in the same block makes a mismatch
    // expected rather than suspicious. Skipping repeats removes the systematic
    // false positive; a genuine one-modify-per-block mismatch still surfaces.
    if (driftBlock !== event.block.number) {
      driftBlock = event.block.number;
      driftSeen = new Set();
    }
    const driftKey = tokenId.toString();
    const firstInBlock = !driftSeen.has(driftKey);
    driftSeen.add(driftKey);

    const onChainLiquidity = BigInt(info.liquidity);
    if (firstInBlock && onChainLiquidity !== liquidity) {
      context.log.info(
        "position liquidity differs from end-of-block contract state " +
          "(expected when the tokenId is modified again later in the block; " +
          "collected fees are unaffected)",
        {
          chainId,
          tokenId: driftKey,
          block: event.block.number,
          indexed: liquidity.toString(),
          onChainEndOfBlock: onChainLiquidity.toString(),
        },
      );
    }
  } else {
    // No usable read ⇒ the baseline cannot be trusted from here on.
    baselineValid = false;
  }

  const curAmount0 = degenerate
    ? 0n
    : getAmount0(tickLower, tickUpper, poolTick, liquidity, poolSqrtPriceX96);
  const curAmount1 = degenerate
    ? 0n
    : getAmount1(tickLower, tickUpper, poolTick, liquidity, poolSqrtPriceX96);

  // Signed raw token deltas for THIS event. Same pure tick math the caller runs
  // for its own analytics rows; recomputed here so this function does not
  // depend on where in the handler it is invoked.
  const eventAmount0 = degenerate
    ? 0n
    : getAmount0(tickLower, tickUpper, poolTick, event.params.liquidityDelta, poolSqrtPriceX96);
  const eventAmount1 = degenerate
    ? 0n
    : getAmount1(tickLower, tickUpper, poolTick, event.params.liquidityDelta, poolSqrtPriceX96);

  let closedAtTimestamp: bigint | undefined;
  if (!isActive) {
    closedAtTimestamp =
      existing && !existing.isActive && existing.closedAtTimestamp != null
        ? existing.closedAtTimestamp
        : BigInt(event.block.timestamp);
  }

  // ── Gas, charged ONCE per transaction ─────────────────────────────────────
  // One tx can carry several ModifyLiquidity events (batched multi-position
  // calls); charging full tx gas to each would multiply the total. Attribute it
  // to the lowest-logIndex row of the tx. Counting only STRICTLY earlier rows
  // is replay-safe: an event's own row keeps its logIndex and never
  // disqualifies itself.
  const txHash = event.transaction.hash;
  const logIndex = BigInt(event.logIndex);
  const gasUsed = event.transaction.gasUsed ?? 0n;
  const gasPrice = event.transaction.effectiveGasPrice ?? 0n;
  const fullGasCost = toHuman(gasUsed * gasPrice, 18);

  const writesRow = event.params.liquidityDelta !== 0n || settled0 > 0 || settled1 > 0;
  let gasCostETH = 0;
  if (writesRow && fullGasCost > 0) {
    if (gasTxHash !== txHash) {
      gasTxHash = txHash;
      gasLogIndex = logIndex;
    }
    gasCostETH = logIndex === gasLogIndex ? fullGasCost : 0;
  }

  const dep0 = existing?.depositedToken0 ?? 0;
  const dep1 = existing?.depositedToken1 ?? 0;
  const wit0 = existing?.withdrawnToken0 ?? 0;
  const wit1 = existing?.withdrawnToken1 ?? 0;

  const next: Position = {
    id,
    chainId: BigInt(chainId),
    tokenId,
    // LOWERCASE for Ponder parity. envio's address_format defaults to checksum,
    // so a consumer filtering `owner = '0xabc...'` in lowercase — which the
    // Ponder-backed backend does — would otherwise match nothing.
    owner: existing?.owner ?? event.transaction.from?.toLowerCase() ?? "NONE",
    origin: existing?.origin ?? event.transaction.from?.toLowerCase() ?? "NONE",
    createdAtTimestamp: existing?.createdAtTimestamp ?? BigInt(event.block.timestamp),
    // BARE bytes32, not the namespaced `poolId` arg — the backend re-adds the
    // chain prefix when it joins these back onto `Pool.id`.
    poolId: event.params.id,
    tickLower,
    tickUpper,
    liquidity,
    isActive,
    isPriceable: !degenerate,
    createdAtBlockNumber: existing?.createdAtBlockNumber
      ? existing.createdAtBlockNumber
      : BigInt(event.block.number),
    closedAtTimestamp,
    depositedToken0: isAdd ? dep0 + toHuman(eventAmount0, token0Decimals) : dep0,
    depositedToken1: isAdd ? dep1 + toHuman(eventAmount1, token1Decimals) : dep1,
    withdrawnToken0: isAdd ? wit0 : wit0 + toHuman(-eventAmount0, token0Decimals),
    withdrawnToken1: isAdd ? wit1 : wit1 + toHuman(-eventAmount1, token1Decimals),
    totalFeesCollected0: (existing?.totalFeesCollected0 ?? 0) + settled0,
    totalFeesCollected1: (existing?.totalFeesCollected1 ?? 0) + settled1,
    // Just settled, so nothing is outstanding. FeeSync refreshes this at head.
    totalFeesUncollected0: 0,
    totalFeesUncollected1: 0,
    amount0: toHuman(curAmount0, token0Decimals),
    amount1: toHuman(curAmount1, token1Decimals),
    feeGrowthInside0LastX128: fg0Last,
    feeGrowthInside1LastX128: fg1Last,
    feeBaselineValid: baselineValid,
    totalGasCostETH: (existing?.totalGasCostETH ?? 0) + gasCostETH,
    updatedAtBlock: BigInt(event.block.number),
    updatedAtTimestamp: BigInt(event.block.timestamp),
  };
  context.Position.set(next);

  const rowBase = {
    chainId: BigInt(chainId),
    txHash,
    logIndex,
    tokenId,
    position_id: id,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: BigInt(event.block.number),
    sender: event.transaction.from?.toLowerCase() ?? "NONE",
  };

  if (event.params.liquidityDelta !== 0n) {
    context.PositionTransaction.set({
      ...rowBase,
      id: `${chainId}_${txHash}_${logIndex}_${isAdd ? "DEPOSIT" : "WITHDRAW"}`,
      type: isAdd ? "DEPOSIT" : "WITHDRAW",
      amount0: toHuman(isAdd ? eventAmount0 : -eventAmount0, token0Decimals),
      amount1: toHuman(isAdd ? eventAmount1 : -eventAmount1, token1Decimals),
      gasCostETH,
    });
  }

  if (settled0 > 0 || settled1 > 0) {
    context.PositionTransaction.set({
      ...rowBase,
      id: `${chainId}_${txHash}_${logIndex}_COLLECT_FEES`,
      type: "COLLECT_FEES",
      amount0: settled0,
      amount1: settled1,
      // Avoid double-charging: gas already went on the DEPOSIT/WITHDRAW row
      // unless this event moved no liquidity (a pure collect).
      gasCostETH: event.params.liquidityDelta === 0n ? gasCostETH : 0,
    });
  }
}

/*
 * ── FeeSync: live uncollected fees + current amounts ────────────────────────
 *
 * Ponder runs this as a `startBlock: "latest"` block handler so it never
 * replays history. Envio has no live-only startBlock, so the equivalent is an
 * `_every` stride plus an `isRealtime` gate: during the historical backfill the
 * handler is invoked but returns immediately, costing nothing.
 *
 * Caveat worth knowing: `context.chain.isRealtime` is true only once EVERY
 * configured chain has reached its head, so on the 18-chain config FeeSync
 * waits for the slowest chain. A single-chain config (config.robinhood.yaml)
 * has no such coupling.
 */
indexer.onBlock(
  {
    name: "FeeSync",
    where: ({ chain }) => {
      const every = feeSyncInterval(chain.id);
      return every ? { block: { number: { _every: every } } } : false;
    },
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    if (!context.chain.isRealtime) return;

    const chainId = context.chain.id;
    if (!feeTrackingEnabled(chainId)) return;
    const positionManager = POSITION_MANAGER_BY_CHAIN[chainId];
    if (!positionManager) return;

    // Both fields are @index'd, so this filters in SQL. Filtering chainId in JS
    // instead would materialise every active position on EVERY configured chain
    // into memory on every tick (getWhere emits no LIMIT).
    const active: Position[] = await context.Position.getWhere({
      isActive: { _eq: true },
      chainId: { _eq: BigInt(chainId) },
    });

    // EVERY active position is refreshed each tick, matching Ponder — a rotating
    // slice would make uncollected fees arbitrarily stale (at ~15k active
    // Robinhood positions, 200 per hourly tick takes three days to come around).
    const mine = active
      .filter((p) => p.poolId !== "")
      .sort((a, b) => (a.updatedAtBlock < b.updatedAtBlock ? -1 : 1))
      .slice(0, MAX_REFRESH_PER_TICK);
    if (mine.length === 0) return;
    if (active.length > MAX_REFRESH_PER_TICK) {
      context.log.warn("FeeSync hit its per-tick cap; oldest positions refreshed first", {
        chainId,
        active: mine.length,
        cap: MAX_REFRESH_PER_TICK,
      });
    }

    // Token decimals per unique pool, loaded ONCE rather than per position.
    // Keyed by the BARE `Position.poolId`; `Pool.id` is namespaced, so the
    // chain prefix is re-added for the lookup.
    const decByPool = new Map<string, { dec0: bigint; dec1: bigint }>();
    for (const bare of new Set(mine.map((p) => p.poolId))) {
      const pool = await context.Pool.get(`${chainId}_${bare}`);
      if (!pool) continue;
      const [t0, t1] = await Promise.all([
        context.Token.get(pool.token0),
        context.Token.get(pool.token1),
      ]);
      decByPool.set(bare, { dec0: t0?.decimals ?? 18n, dec1: t1?.decimals ?? 18n });
    }

    // Fetch live state through Multicall3, one eth_call per batch. The
    // per-position variant cost 3 requests each, which at ~2,600 active
    // positions could not complete a pass inside the tick interval.
    const refreshable = mine.filter(
      (p) => p.tickLower != null && p.tickUpper != null && p.poolId !== "",
    );
    const liveById = new Map<string, LiveState | null>();
    for (let i = 0; i < refreshable.length; i += POSITIONS_PER_BATCH) {
      const slice = refreshable.slice(i, i + POSITIONS_PER_BATCH);
      const results = await context.effect(refreshPositionsBatch, {
        blockNumber: block.number,
        owner: positionManager,
        items: slice.map((p) => ({
          // Already bare — the effect wants the raw bytes32 pool id.
          poolId: p.poolId,
          tickLower: Number(p.tickLower),
          tickUpper: Number(p.tickUpper),
          salt: saltOf(p.tokenId),
        })),
      });
      slice.forEach((p, j) => liveById.set(p.id, results[j] ?? null));
    }

    for (const p of refreshable) {
      const live = liveById.get(p.id);
      if (!live) continue;
      if (p.tickLower == null || p.tickUpper == null) continue;

      // No `?? 18n` fallback: a missing Token row would mis-scale amounts and
      // uncollected fees by 10^(18-decimals). Ponder rejects that pattern
      // explicitly; skipping leaves the previous values, which are at worst
      // stale rather than wrong by orders of magnitude.
      const dec = decByPool.get(p.poolId);
      if (!dec) continue;
      const { dec0, dec1 } = dec;

      const liquidity = BigInt(live.liquidity);
      const sqrtPriceX96 = BigInt(live.sqrtPriceX96);
      const tick = BigInt(live.tick);
      const nowActive = liquidity > 0n;
      const degenerate = isDegenerate(tick, sqrtPriceX96);

      const update: PositionUpdate = {
        liquidity,
        isActive: nowActive,
        updatedAtBlock: BigInt(block.number),
      };

      if (!nowActive) {
        update.totalFeesUncollected0 = 0;
        update.totalFeesUncollected1 = 0;
        // Liquidity only ever changes through modifyLiquidity, so the event path
        // has already stamped closedAtTimestamp from the real block timestamp.
        // Reaching here with the row still marked active means an event was
        // missed — surface it rather than inventing a close time from the last
        // update's clock (which can be arbitrarily stale).
        if (p.isActive) {
          context.log.warn("FeeSync saw zero liquidity on a position still marked active", {
            chainId,
            tokenId: p.tokenId.toString(),
            block: block.number,
          });
        }
      } else if (p.closedAtTimestamp != null) {
        // Reopened: liquidity is back above zero, so clear the stale close time.
        update.closedAtTimestamp = undefined;
      }

      if (nowActive && !degenerate) {
        update.amount0 = toHuman(
          getAmount0(p.tickLower, p.tickUpper, tick, liquidity, sqrtPriceX96),
          dec0,
        );
        update.amount1 = toHuman(
          getAmount1(p.tickLower, p.tickUpper, tick, liquidity, sqrtPriceX96),
          dec1,
        );
      }

      // Only diff feeGrowthInside while IN RANGE. Out of range the lens returns
      // a near-2^256 value and the diff is an astronomical artifact — but an
      // out-of-range position earns no new fees, so 0 there is exact. Either way
      // re-baseline to the contract's stored value so accrual resumes cleanly.
      const inRange = isInRange(tick, p.tickLower, p.tickUpper);
      const fg0Last = BigInt(live.feeGrowthInside0LastX128);
      const fg1Last = BigInt(live.feeGrowthInside1LastX128);
      if (nowActive && inRange) {
        const u = calculateUncollectedFees(
          liquidity,
          BigInt(live.feeGrowthInside0X128),
          BigInt(live.feeGrowthInside1X128),
          fg0Last,
          fg1Last,
        );
        update.totalFeesUncollected0 = toHuman(u.amount0, dec0);
        update.totalFeesUncollected1 = toHuman(u.amount1, dec1);
        update.feeGrowthInside0LastX128 = fg0Last;
        update.feeGrowthInside1LastX128 = fg1Last;
      } else if (nowActive) {
        update.totalFeesUncollected0 = 0;
        update.totalFeesUncollected1 = 0;
        update.feeGrowthInside0LastX128 = fg0Last;
        update.feeGrowthInside1LastX128 = fg1Last;
      }

      context.Position.set({ ...p, ...update });
    }
  },
);
