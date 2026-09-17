/*
 * The two ModifyLiquidity fee gates, in ONE place each.
 *
 * WHY THIS MODULE EXISTS
 *
 * `getFeeGrowthInside` is issued from TWO call sites in
 * `handlers/modifyLiquidity-handler.ts` — the preload block and the real path —
 * so that the whole batch's reads go out in parallel instead of one at a time
 * (see `PRELOAD` below). Two call sites with a copy of the predicate in each is
 * the failure mode that matters: the moment they disagree, the preload pass
 * warms an input the real pass never asks for (pure waste) or, far worse, the
 * real pass asks for one the preload pass skipped and pays full RPC latency
 * inside the strictly serial handler loop. So the predicate lives here, once,
 * and both sites call it.
 *
 * `shouldTraceFees` is here for the same reason in reverse: it has one call
 * site, but it is the gate that decides whether a `debug_traceTransaction`
 * runs, i.e. whether a collected fee is measured or silently recorded as zero.
 * Exact collected fees are this indexer's hard requirement, so that predicate is
 * a named, unit-tested function rather than a condition buried in a 700-line
 * handler.
 *
 * PRELOAD, AS ENVIO 3.7.0 ACTUALLY IMPLEMENTS IT
 *
 * A batch is processed in two passes. `preloadBatchOrThrow`
 * (`EventProcessing.res.mjs:225`) invokes EVERY handler in the batch
 * concurrently with `isPreload: true`; `runBatchHandlersOrThrow` (:229) then
 * runs them again in a STRICTLY SERIAL for-loop.
 *
 * `UserContext.res.mjs:69` passes `isPreload` straight through as
 * `shouldGroup`, so in the preload pass effect calls are GROUPED — collected and
 * handed to `LoadLayer.executeWithRateLimit` together — while in the real pass
 * `shouldGroup` is false and `LoadManager.call` (`LoadManager.res.mjs:80`)
 * returns the in-memory value without touching the network. The dict it reads is
 * only cleared BEFORE the preload pass, never between the two.
 *
 * The consequence, which is the whole point of hoisting: a read issued in the
 * preload pass is issued ONCE, and the real pass's identical call is free. It is
 * not "issued twice" — that claim was measured false on 3.7.0 with both
 * `cache: true` and `cache: false`. What the real pass costs is exactly what the
 * preload pass did not warm.
 *
 * The inputs must therefore be IDENTICAL between the passes, because the memo is
 * keyed on the input. That is the other reason for one shared constructor:
 * `effectInput` below is built in one place, so the two passes cannot drift into
 * two different cache keys and pay for the read twice.
 */

import { type EvmOnEventContext } from "envio";

import { getFeeGrowthInside } from "../effects/positionState";
import { isDegenerate, tokenIdFromSalt } from "./positions";
import { positionManagerFor, v4AddressesFor } from "./v4Addresses";

type handlerContext = EvmOnEventContext;

/**
 * Everything the gate needs, and nothing that is unavailable before the
 * handler's own guard.
 *
 * `poolTick` / `poolSqrtPrice` are the POOL AS READ FROM THE STORE, not the
 * handler's mutated copy. The two are interchangeable here and that is a
 * property worth stating rather than assuming: the handler's `pool` is built by
 * spreading `existingPool` and overriding `txCount`,
 * `totalValueLockedToken0/1`, `liquidity`, `totalValueLockedETH` and
 * `totalValueLockedUSD` (modifyLiquidity-handler.ts:169-213). `tick` and
 * `sqrtPrice` are never among them, so `pool.tick === existingPool.tick` and
 * `pool.sqrtPrice === existingPool.sqrtPrice` by construction, and
 * `isDegenerate` — which reads only those two — returns the same answer from
 * either. That is what lets the preload block, which runs before `pool` exists,
 * evaluate the identical predicate.
 */
export interface FeeGateEvent {
  readonly chainId: number;
  /** `event.params.sender`, EIP-55 checksummed as Envio delivers it. */
  readonly sender: string;
  readonly salt: string;
  /** `event.params.id`, the v4 PoolId (bytes32), NOT the chain-namespaced row id. */
  readonly poolId: string;
  readonly tickLower: bigint;
  readonly tickUpper: bigint;
  readonly blockNumber: number;
  readonly poolTick: bigint | undefined;
  readonly poolSqrtPrice: bigint | undefined;
}

/** The exact `getFeeGrowthInside` input, built in one place so both passes agree. */
export interface FeeGrowthEffectInput {
  // No `chainId`. `getFeeGrowthInside` is chain-scoped, so the chain is the
  // cache table and the handler reads it from `context.chain.id`.
  readonly stateView: string;
  readonly poolId: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly blockNumber: bigint;
}

export interface FeeGateDecision {
  /**
   * Is this event attributable to an NFT position at all — i.e. was the caller
   * the canonical PositionManager, so that `salt` really is a tokenId?
   *
   * The preload block uses this to decide whether warming the position-side
   * reads is worth a query, and the real path re-derives the same answer from
   * its own `positionManagerFor` / sender check.
   */
  readonly attributable: boolean;
  /** The NFT tokenId, when `attributable` and the salt carries one. */
  readonly tokenId: bigint | undefined;
  /** Must `getFeeGrowthInside` be issued for this event? */
  readonly read: boolean;
  /** Present iff `read`. */
  readonly effectInput: FeeGrowthEffectInput | undefined;
}

const NO_READ = { read: false as const, effectInput: undefined };

/**
 * THE single source of truth for "does this ModifyLiquidity need a
 * getFeeGrowthInside read, and for which position".
 *
 * The read is gated on `!degenerate` ALONE among the fee conditions — the same
 * place Ponder has it (apps/v4/src/index.ts:211-212) — and deliberately NOT on
 * the trace gate's `hadPosition && liquidity > 0` conjuncts. Gating it on those
 * silently lost fees: a mint has no prior position, so the read was skipped and
 * the position's `feeGrowthInside*LastX128` baseline stayed at `newPosition()`'s
 * 0, which is indistinguishable from the genuine (0, 0) a cleared tick pair
 * reports on a later close. See the `shouldTraceFees` note below.
 */
export function feeGate(e: FeeGateEvent): FeeGateDecision {
  // A chain with no PositionManager entry cannot attribute anything: `salt` is
  // an arbitrary caller-supplied bytes32 unless the PositionManager put a
  // tokenId there. Same guard, same order, as the handler's own.
  const positionManager = positionManagerFor(e.chainId);
  if (!positionManager || e.sender.toLowerCase() !== positionManager) {
    return { attributable: false, tokenId: undefined, ...NO_READ };
  }

  const tokenId = tokenIdFromSalt(e.salt);
  if (tokenId === undefined) {
    return { attributable: true, tokenId: undefined, ...NO_READ };
  }

  // Tick math is meaningless at the edges of the representable domain, so a
  // degenerate pool's amounts are zeroed and no fee read is worth an RPC.
  if (isDegenerate(e.poolTick ?? 0n, e.poolSqrtPrice ?? 0n)) {
    return { attributable: true, tokenId, ...NO_READ };
  }

  return {
    attributable: true,
    tokenId,
    read: true,
    effectInput: {
      // No `chainId`: `getFeeGrowthInside` is chain-scoped, so the chain is the
      // cache table, and the handler reads it from `context.chain.id`.
      // `?? ""` rather than a skip, matching the call site this replaced: a
      // chain with no StateView produces a failing read, which returns
      // `ok: false` and therefore FORCES the trace. Skipping would instead
      // produce `undefined`, which reads as "unchanged" and would silently
      // record no collected fee.
      stateView: v4AddressesFor(e.chainId)?.stateView ?? "",
      poolId: e.poolId,
      tickLower: Number(e.tickLower),
      tickUpper: Number(e.tickUpper),
      blockNumber: BigInt(e.blockNumber),
    },
  };
}

/** What `getFeeGrowthInside` resolves to, or `undefined` when the gate said no. */
export type FeeGrowthReading =
  | { readonly ok: boolean; readonly feeGrowthInside0X128: bigint; readonly feeGrowthInside1X128: bigint }
  | undefined;

/**
 * Evaluate the gate and, when it passes, issue `getFeeGrowthInside`.
 *
 * Called from BOTH passes with the same arguments. In the preload pass the
 * result is discarded — the point is the side effect of populating the effect's
 * in-memory output dict, exactly as `preloadIntervalData` populates the load
 * layer's (utils/intervalUpdates.ts:159-171). In the real pass the same call
 * short-circuits to that dict and costs nothing.
 */
export async function readFeeGrowthInside(
  context: handlerContext,
  e: FeeGateEvent,
): Promise<FeeGrowthReading> {
  const gate = feeGate(e);
  if (!gate.read || !gate.effectInput) return undefined;
  return await context.effect(getFeeGrowthInside, gate.effectInput);
}

/**
 * Does this event need a `debug_traceTransaction` to learn its collected fee?
 *
 *     gateCanPass
 *
 * That is the whole predicate, and the single argument is deliberately still a
 * named function rather than an inlined boolean: it is the one place that
 * decides whether a collected fee is MEASURED or silently recorded as zero, and
 * the two heuristics that used to sit here are exactly the kind that get
 * reintroduced by a well-meaning "cheap skip" patch. They cannot be
 * reintroduced now without changing this signature.
 *
 * `gateCanPass` is Ponder's provably-zero skip, minus its degenerate-pool
 * conjunct: see the handler, where it is built, for why a mint provably has no
 * fees and why dropping the pool guard is right.
 *
 * ─── WHAT WAS REMOVED, AND WHY IT HAD TO GO ────────────────────────────────
 *
 * The predicate was `gateCanPass && (feeGrowthChanged || liquidityDelta < 0n)`.
 * Both disjuncts are gone.
 *
 * 1. `feeGrowthChanged` IS NOT A CONSERVATIVE HEURISTIC — IT IS UNSOUND. It
 *    compares two quantities that are not comparable. The fresh read is
 *    POOL-level `feeGrowthInside(poolId, tickLower, tickUpper)` sampled at
 *    END OF BLOCK; the fee it is being used to predict is determined by the
 *    POSITION's own `feeGrowthInsideLast` checkpoint, taken MID-TRANSACTION
 *    when the position last settled. Those two are not the same series and
 *    nothing forces them to converge:
 *
 *      - They diverge PERMANENTLY at mint. A position minted into a range that
 *        already has fee growth takes a non-zero checkpoint, while the baseline
 *        this indexer stores is whatever the end-of-block read returned. The
 *        difference never closes, so `feeGrowthChanged` can read false for a
 *        position's ENTIRE LIFE. Proved on 43114_1356.
 *      - BLOCK GRANULARITY cannot see accrual inside the settling block. Swaps
 *        earlier in the same block move `feeGrowthInside` between the position's
 *        checkpoint and the end-of-block sample; a read at block granularity
 *        cannot distinguish that from no movement at all. Proved on 43114_378.
 *
 *    An earlier version of this docstring asserted the heuristic "keeps in full"
 *    on the INCREASE path, on the argument that the (0, 0)-from-cleared-ticks
 *    ambiguity does not arise there. THAT CLAIM IS FALSE, and 43114_3132 in the
 *    evidence file is the counterexample: it is a fee-bearing POSITIVE-delta
 *    settlement — 96 of them exist in the audited population — that the
 *    heuristic skipped. The hole is not about cleared ticks; it is about
 *    comparing a pool-level end-of-block number against a position-level
 *    mid-transaction one.
 *
 * 2. `liquidityDelta < 0n` was the 2024 partial fix for (1) and is false for
 *    the majority of real settlements: 69.9% of fee-bearing settlements are
 *    ZERO-delta pure collects, where `< 0n` does not hold.
 *
 * MEASURED, against all 1,167 wrong Avalanche positions with every one of their
 * ~2,062 settlement transactions traced and decoded: this gate change ALONE
 * still leaves 750 of 1,167 wrong, and the frame-picker fix alone leaves 785
 * wrong. Both together leave 0. Neither is optional and neither is sufficient.
 *
 * ─── WHAT IT COSTS ─────────────────────────────────────────────────────────
 *
 * A trace is per TRANSACTION, not per event: `getFeesAccrued` is keyed on
 * (chainId, txHash, poolManager) with `cache: true`, so a 15-frame router batch
 * is ONE trace, every event in it shares that trace, and a resync with a warm
 * cache pays nothing. Measured over the whole history of chain 43114: +7,381
 * traces, at most 1.6x. The conjunct that keeps it there is
 * `existing.liquidity > 0n` inside `gateCanPass` — mints are the bulk of
 * ModifyLiquidity and they never reach this.
 *
 * `getFeeGrowthInside` is still read on every attributable event, and that is
 * not vestigial: it feeds `feeGrowthInside0/1LastX128` on the Position row,
 * which the schema exposes and the head sweep diffs against. It is simply no
 * longer allowed to veto a trace.
 */
export function shouldTraceFees(args: { readonly gateCanPass: boolean }): boolean {
  return args.gateCanPass;
}

/**
 * `gateCanPass` itself — the provably-zero skip, and the ONE detectable case
 * that must override it.
 *
 * Extracted from the handler so that "a mint traces nothing" is a unit test
 * rather than a claim, and so that `degenerate` is not even in scope to be
 * re-added: a degenerate pool's TICK MATH is meaningless, but `feesAccrued` is a
 * return value read from the trace, not tick math, and its collected fee is real
 * money. The handler still zeroes every tick-derived amount on such a pool.
 *
 * WHAT EACH ARGUMENT PROVES.
 *
 *  - `hadPosition` / `storedLiquidity > 0n`: a position this indexer has never
 *    seen, or that held no liquidity, cannot have accrued fees — v4 accrues
 *    against liquidity. A MINT is exactly this case, which is what keeps the
 *    positive-delta majority of ModifyLiquidity off the trace path and is why
 *    the widened gate costs at most 1.6x rather than 100x.
 *
 *  - `storedLiquidity === 0n && liquidityDelta <= 0n`: the stored zero cannot be
 *    trusted, so it must not be used to prove there are no fees.
 *
 *    For `< 0n` the proof is direct: a decrease against a position with no
 *    liquidity is impossible on-chain — the PoolManager reverts it — so seeing
 *    one proves the STORE is behind (the handler clamps a negative running
 *    liquidity to 0 and warns).
 *
 *    `== 0n` IS INCLUDED DELIBERATELY, AND WAS THE BUG. It was `< 0n`, which
 *    covered only withdrawals, so a pure collect against the same known-bad row
 *    fell through to `hadPosition && storedLiquidity > 0n`, failed it, and had
 *    its fee recorded as zero with no log line of any level. Pure collects are
 *    69.9% of fee-bearing settlements — the same share that made the old
 *    `liquidityDelta < 0n` gate cover barely a third of the Avalanche damage.
 *    Once a row is clamped to 0 it also drops out of the fee sweep's candidate
 *    filter, so nothing ever re-reads it from chain: the loss is permanent and
 *    `totalFeesCollected` is append-only.
 *
 *    The justification is the DESYNC, not the position: a stored zero already
 *    known to be wrong cannot prove "no fees" for a collect any more than it can
 *    for a withdraw. (Do not lean on "a zero-liquidity position can still hold
 *    uncollected fees" — v4 settles fees on the burn that takes liquidity to
 *    zero, and a cleared tick pair then reads exactly (0, 0).) Cost is bounded:
 *    `getFeesAccrued` is cached per TRANSACTION, so a batch is one trace.
 */
export function traceGateCanPass(args: {
  readonly hadPosition: boolean;
  readonly storedLiquidity: bigint;
  readonly liquidityDelta: bigint;
}): boolean {
  const storeLiquidityDesynced = args.storedLiquidity === 0n && args.liquidityDelta <= 0n;
  return (args.hadPosition && args.storedLiquidity > 0n) || storeLiquidityDesynced;
}
