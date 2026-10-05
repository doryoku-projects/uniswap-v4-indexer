/*
 * THE BODY of the uncollected-fee sweep — what one firing of
 * `handlers/feeSync-block.ts` does once its gates have passed.
 *
 * A separate module so it can be driven with a mock context. The handler file
 * cannot be imported by a test: it resolves the chain heads with a top-level
 * `await` (an RPC per active chain at module load) and registers itself with
 * `indexer.onBlock`. Everything that decides a VALUE lives here; the handler
 * keeps registration, the preload early-return, the head gate and the clock.
 *
 * WHAT ONE FIRING DOES
 *
 *   1. Selects up to SWEEP_BATCH_SIZE stale candidates — active, liquidity > 0,
 *      a real pool — oldest fee read first.
 *   2. Resolves each candidate's pool and tokens from the store. No pool or no
 *      token row ⇒ skipped: no read and no write.
 *   3. Reads EVERY remaining candidate — in range or not — in one Multicall3 per
 *      SWEEP_CHUNK (`getFeeGrowthInside` + `getPositionInfo` at this block).
 *   4. Writes, per position: the modular uncollected fee, the liquidity and
 *      `isActive` healed from chain, amounts refreshed at the pool's current
 *      price, the contract's checkpoint, and the fee watermark. A failed read
 *      writes ONLY the fee watermark.
 *
 * OUT-OF-RANGE POSITIONS ARE READ, AND THAT REVERSES A DECISION. The sweep used
 * to read only in-range positions and write 0/0 for the rest without a read, on
 * the claim that "an out-of-range position accrues no new fees, so its
 * uncollected amount is exactly zero". The premise is true and the conclusion
 * is not: a position that LEFT the range still holds whatever accrued while it
 * was in range and has not been collected. Verified on chain — mainnet tokenIds
 * 10014 and 100022 were out of range with claimable fees, served here as 0. And
 * the zeroed path never refreshed their amounts or healed their liquidity
 * either. The cost of reading them is bounded by the same 400-row cap — the
 * firing processes the same number of rows as before (out-of-range rows were
 * already stamped with the watermark); only the share that costs a multicall
 * slot grew. Ponder's `onFeeSync` (apps/v4/src/handlers/position-side.ts) made
 * the identical change and was verified on 1,000/1,000 + 144/144 positions.
 *
 * `updatedAtBlock` MOVES ONLY ON A HEAL. The fee watermark
 * (`feesUpdatedAtBlock`) and the change-feed watermark (`updatedAtBlock`) are
 * separate on purpose — the backend fans out a refresh per `updatedAtBlock`
 * change, and a plain fee or price refresh moving it would present the whole
 * active set as changed every sweep. But a healed `liquidity` / `isActive` IS a
 * position change (a missed event, or a close the running sum never saw), and
 * the old sweep healed it without telling the change feed, so the backend kept
 * serving the stale liquidity until some unrelated event touched the row.
 */

import { type EvmOnBlockContext, type Pool, type Position, type Token } from "envio";

import { getPositionFeeGrowthBatch } from "../effects/positionState";
import { calculateUncollectedFees } from "./fees";
import { convertTokenToDecimal } from "./index";
import { currentAmounts, isDegenerate, isInRange } from "./positions";
import type { V4Addresses } from "./v4Addresses";

/**
 * Positions per firing, and per multicall.
 *
 * The cap is the whole point: it makes a firing's cost bounded rather than
 * proportional to the position count, so a sweep can never take longer than its
 * own interval and start compounding. Ponder selected every active position
 * with no limit, and once one firing exceeded its interval each further
 * interval queued another full refresh — which is how two of its four chains
 * ended up permanently frozen.
 *
 * `SWEEP_CHUNK` mirrors Ponder's `refreshChunk` (400): one Multicall3 request
 * carries a whole chunk, so the request count is positions/400 rather than
 * positions. Reading one position per request — which this handler did before —
 * multiplied node load by 400 for identical data. Reading out-of-range positions
 * too does not raise the widest request: a chunk was already up to 400
 * positions (800 sub-calls) when every candidate happened to be in range.
 */
export const SWEEP_BATCH_SIZE = 400;
export const SWEEP_CHUNK = 400;

export interface SweepArgs {
  readonly chainId: number;
  /** The block this firing reads at (and stamps as the fee watermark). */
  readonly blockNumber: bigint;
  /** The chain's sweep stride, in blocks. */
  readonly interval: bigint;
  /** Wall-clock seconds — a block handler is given no block timestamp. */
  readonly sweptAt: bigint;
  readonly addresses: V4Addresses;
}

export interface SweepSummary {
  /** Stale rows selected this firing (after the filter and the cap). */
  readonly candidates: number;
  /** Positions whose read succeeded and whose values were written. */
  readonly read: number;
  /** Of `read`, how many were out of range at the pool's current tick. */
  readonly outOfRange: number;
  /** Positions whose read failed — watermark stamped, values kept. */
  readonly failed: number;
  /** Of `read`, how many had liquidity / isActive healed from chain. */
  readonly healed: number;
  /** No pool or token row — neither read nor written. */
  readonly skipped: number;
}

interface Priced {
  readonly position: Position;
  readonly pool: Pool;
  readonly token0: Token;
  readonly token1: Token;
}

/** One firing of the sweep. Writes through `context.Position.set`. */
export async function sweepUncollectedFees(
  context: EvmOnBlockContext,
  args: SweepArgs,
): Promise<SweepSummary> {
  const { chainId, blockNumber, interval, sweptAt, addresses } = args;

  // Ask for the positions this cycle has not refreshed, rather than reading
  // every active position and sorting in memory. `feesUpdatedAtBlock` is
  // indexed for exactly this query, which is what keeps the working set
  // bounded — Ponder's old unbounded `select ... where isActive` is the reason
  // one slow firing there compounded into a permanent stall.
  // `_lte`, not `_lt`: consecutive `_every` firings are exactly `interval`
  // apart, so a row stamped at the previous firing has
  // `feesUpdatedAtBlock === blockNumber - interval` exactly. Under `_lt` it
  // misses by one and waits a further full interval, halving the real refresh
  // cadence relative to the configured one.
  const cutoff = blockNumber - interval;
  const stale = await context.Position.getWhere({
    chainId: { _eq: BigInt(chainId) },
    feesUpdatedAtBlock: { _lte: cutoff < 0n ? 0n : cutoff },
  });

  // A position with no liquidity earns nothing, and one with no pool has not
  // seen its first ModifyLiquidity yet.
  //
  // Sorted explicitly by watermark. `getWhere` gives no ordering guarantee, so
  // the "oldest fee-read first" rotation this cap depends on is not free: an
  // arbitrary order can re-pick the same 400 rows every firing and starve the
  // rest indefinitely.
  const candidates = stale
    .filter((p) => p.isActive && p.liquidity > 0n && p.poolId !== "")
    .sort((a, b) =>
      a.feesUpdatedAtBlock < b.feesUpdatedAtBlock ? -1 : a.feesUpdatedAtBlock > b.feesUpdatedAtBlock ? 1 : 0,
    )
    .slice(0, SWEEP_BATCH_SIZE);

  let read = 0;
  let outOfRange = 0;
  let failed = 0;
  let healed = 0;
  let skipped = 0;

  if (candidates.length === 0) {
    return { candidates: 0, read, outOfRange, failed, healed, skipped };
  }

  // Pool and tokens first, before any RPC, so a row that could not be written
  // anyway does not spend a multicall slot. Memoised per pool: a firing's 400
  // rows routinely share a handful of pools.
  const byPool = new Map<string, Omit<Priced, "position"> | null>();
  const toRead: Priced[] = [];
  for (const position of candidates) {
    let info = byPool.get(position.poolId);
    if (info === undefined) {
      const pool = await context.Pool.get(`${chainId}_${position.poolId}`);
      const token0 = pool ? await context.Token.get(pool.token0) : undefined;
      const token1 = pool ? await context.Token.get(pool.token1) : undefined;
      info = pool && token0 && token1 ? { pool, token0, token1 } : null;
      byPool.set(position.poolId, info);
    }
    if (!info) {
      skipped += 1;
      continue;
    }
    toRead.push({ position, ...info });
  }

  // EVERY candidate is read — see the header for why out-of-range ones are no
  // longer zeroed without a read. One Multicall3 per chunk, as Ponder does.
  for (let start = 0; start < toRead.length; start += SWEEP_CHUNK) {
    const chunk = toRead.slice(start, start + SWEEP_CHUNK);
    const states = await context.effect(getPositionFeeGrowthBatch, {
      stateView: addresses.stateView,
      positionManager: addresses.positionManager,
      multicall3: addresses.multicall3,
      blockNumber,
      positions: chunk.map(({ position: p }) => ({
        tokenId: p.tokenId,
        poolId: p.poolId,
        tickLower: Number(p.tickLower),
        tickUpper: Number(p.tickUpper),
      })),
    });

    const byTokenId = new Map(states.map((s) => [s.tokenId, s]));

    for (const { position, pool, token0, token1 } of chunk) {
      const state = byTokenId.get(position.tokenId);

      // A failed read keeps the previous uncollected value — a stale fee is
      // recoverable, a fabricated zero is not distinguishable from a real one.
      //
      // But the watermark IS stamped either way, which is Ponder's behaviour:
      // its per-position write is unconditional. Skipping the write instead
      // leaves the row below the cutoff forever, so a persistently failing read
      // re-selects the same positions on every firing and the stale set can
      // only grow — which is exactly what a broken multicall produced here.
      if (!state || !state.ok) {
        failed += 1;
        context.Position.set({
          ...position,
          feesUpdatedAtBlock: blockNumber,
          feesUpdatedAtTimestamp: sweptAt,
        });
        continue;
      }
      read += 1;

      const poolTick = pool.tick ?? 0n;
      if (!isInRange(position.tickLower, position.tickUpper, poolTick)) outOfRange += 1;

      /*
       * SELF-HEAL from the chain, which Ponder does on every sweep.
       *
       * `position.liquidity` is a running sum of `liquidityDelta` over the
       * events we saw; `state.liquidity` is what the contract holds right now.
       * They should be equal, and if they are not the contract is right —
       * Ponder writes the on-chain value unconditionally precisely so a missed
       * or out-of-order event heals on the next cycle instead of drifting
       * forever. Every candidate is read now, so every candidate heals; the old
       * "in-range only" limit is gone with the in-range partition.
       */
      const liquidity = state.liquidity;
      const nowActive = liquidity > 0n;
      const isHeal = liquidity !== position.liquidity || nowActive !== position.isActive;
      if (isHeal) healed += 1;

      // The modular formula, against the contract's own checkpoint read in the
      // SAME multicall at the SAME block — the caller contract
      // `calculateUncollectedFees` requires. In range or out.
      const uncollected = calculateUncollectedFees(
        // The on-chain liquidity, not our running sum: if they disagree, the
        // contract is right and the fee must be computed against its value.
        liquidity,
        state.feeGrowthInside0X128,
        state.feeGrowthInside1X128,
        state.feeGrowthInside0LastX128,
        state.feeGrowthInside1LastX128,
      );

      // Refresh the pooled amounts too. A position's token split moves with the
      // pool price even when the position itself never changes, so computing
      // them only on ModifyLiquidity leaves them frozen at the last liquidity
      // event. The tick here is event-maintained rather than read (in v4 only a
      // swap moves it), so this costs no RPC — and it is guarded by the same
      // degenerate-pool check Ponder applies: tick math at the domain edges
      // produces garbage, so a degenerate pool keeps the stored amounts.
      const amounts = isDegenerate(poolTick, pool.sqrtPrice)
        ? { amount0: position.amount0, amount1: position.amount1 }
        : currentAmounts({
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            liquidity,
            pool: { tick: poolTick, sqrtPriceX96: pool.sqrtPrice },
            decimals0: token0.decimals,
            decimals1: token1.decimals,
          });

      context.Position.set({
        ...position,
        liquidity,
        isActive: nowActive,
        // Closing and reopening, mirroring Ponder's two branches: stamp on the
        // transition to zero, preserve an existing close time, and CLEAR it
        // when liquidity returns so a reopened position is not left looking
        // closed.
        closedAtTimestamp: nowActive ? undefined : (position.closedAtTimestamp ?? sweptAt),
        totalFeesUncollected0: convertTokenToDecimal(uncollected.amount0, token0.decimals),
        totalFeesUncollected1: convertTokenToDecimal(uncollected.amount1, token1.decimals),
        amount0: amounts.amount0,
        amount1: amounts.amount1,
        // Re-baseline to the contract's stored checkpoint. Ponder does this on
        // both branches; the port previously never wrote these at all.
        feeGrowthInside0LastX128: state.feeGrowthInside0LastX128,
        feeGrowthInside1LastX128: state.feeGrowthInside1LastX128,
        feesUpdatedAtBlock: blockNumber,
        feesUpdatedAtTimestamp: sweptAt,
        /*
         * The change-feed watermark moves on a HEAL and on nothing else the
         * sweep writes — not the fee, not the price-driven amounts, not the
         * checkpoint. `updatedAtTimestamp` takes the sweep's wall clock because
         * a block handler has no block timestamp (see `sweptAt` in the
         * handler); it is the only clock available, and the block number is the
         * authoritative half of the pair.
         */
        ...(isHeal ? { updatedAtBlock: blockNumber, updatedAtTimestamp: sweptAt } : {}),
      });
    }
  }

  return { candidates: candidates.length, read, outOfRange, failed, healed, skipped };
}
