/*
 * EXACT collected fees for a position, from debug_traceTransaction.
 *
 * A port of the Ponder indexer's `core/fees-trace.ts`, mechanism unchanged.
 *
 * WHY A TRACE IS UNAVOIDABLE
 *
 * `PoolManager.modifyLiquidity` returns `(BalanceDelta callerDelta, BalanceDelta
 * feesAccrued)`. `feesAccrued` IS the exact collected fee — in range or out,
 * ERC-20 or native — and it appears in NO event or log. v4 has no Collect event,
 * and `ModifyLiquidity` carries only `{id, sender, tickLower, tickUpper,
 * liquidityDelta, salt}`. So the call trace is the only foolproof source, which
 * is why Ponder reads it and why this port keeps doing so rather than deriving
 * an approximation.
 *
 * IT NEVER THROWS, and the reason is NOT the one an earlier version of this
 * comment gave. See the note on TRANSIENT_BACKOFF_MS below: an uncaught throw
 * in the REAL pass is a fatal exit, but the preload pass swallows it, and the
 * decisive argument is about dedup rather than crashes — a failed effect is
 * neither memoised nor deduped, so throwing turns one failed trace into a
 * pile of serial re-invocations. Every failure path here degrades to "no
 * collected fee recorded" with a warning instead.
 *
 * WHAT THE EFFECT WRAPPER ADDS OVER PONDER
 *
 * Ponder caches the trace for the CURRENT transaction only, in a module-level
 * variable, so a batched multi-position transaction is traced once — but that
 * cache dies with the process and every rebuild re-traces the entire history.
 * Envio's effect cache is persisted and keyed on the input, so a SUCCESSFUL
 * trace is taken once EVER, across restarts and resyncs, and `rateLimit` bounds
 * the archive node natively. That per-TRANSACTION key is also what makes the
 * widened trace gate affordable: a 15-frame router batch is one trace shared by
 * every event in it, measured at +7,381 traces and at most 1.6x over the whole
 * history of chain 43114. Degraded results opt out via `context.cache = false`
 * — caching one would make a transient provider failure a permanent zero. That makes the per-transaction cache redundant: it is
 * subsumed by returning every salt's fees for the whole transaction in one
 * cached call, which is exactly what this effect's output does.
 */

import { createEffect, S, type EffectArgs } from "envio";
import { createPublicClient, http, decodeFunctionData, toFunctionSelector } from "viem";
import type { PublicClient } from "viem";

import { absBig, decodeBalanceDelta } from "../utils/fees";
import { getRpcUrl } from "../utils/rpc";

/**
 * Exported ONLY so the pairing tests and the replay harness encode calldata with
 * the exact shape this file decodes, rather than a hand-copied second version of
 * it that could drift.
 */
export const MODIFY_LIQ_ABI = [
  {
    type: "function",
    name: "modifyLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "liquidityDelta", type: "int256" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [
      { name: "callerDelta", type: "int256" },
      { name: "feesAccrued", type: "int256" },
    ],
  },
] as const;

const MODIFY_LIQ_SELECTOR = toFunctionSelector(MODIFY_LIQ_ABI[0]);

/**
 * Some providers return a NON-DETERMINISTIC trace: observed on Arbitrum, a
 * transaction that succeeded on-chain intermittently comes back "execution
 * reverted" with no BalanceDelta output, from flaky full-versus-archive routing.
 * Retry until a usable trace arrives. (An earlier version of this comment
 * claimed a retry "round-robins to a different node"; nothing here or in viem
 * guarantees that — whether a retry reaches a different backend is entirely up
 * to the provider's load balancer. The retry is worth making regardless, since
 * the observed failure is intermittent, but the mechanism is not ours to claim.)
 */
const TRACE_MAX_ATTEMPTS = 5;
const TRACE_RETRY_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * THIS EFFECT MUST NEVER THROW, and that is not a style preference.
 *
 * TWO REASONS, AND THE SECOND IS THE STRONGER ONE. An earlier version of this
 * comment gave only the first, and stated it too broadly.
 *
 * 1. A throw is fatal — UNCAUGHT, AND ONLY IN THE REAL PASS. Envio 3.7.0 has no
 *    retry and no skip for an exception that escapes a handler in the
 *    sequential pass: `EventProcessing.res.mjs:57-66` wraps it as
 *    `ProcessingError` and `BatchProcessing.res.mjs:62-64` hands the result
 *    straight to `IndexerState.errorExit`. But the PRELOAD pass swallows it —
 *    every preload handler promise goes through `Utils.$$Promise.silentCatch`
 *    (`EventProcessing.res.mjs:124-138`) — so "a throw is a fatal exit of the
 *    whole indexer", full stop, is not true as written. It forbids as
 *    impossible a pattern that is merely inadvisable.
 *
 * 2. THE DEDUP ARGUMENT, which holds in both passes and is why the sentinel
 *    returns below are KEPT rather than replaced by throws. An effect's result
 *    is memoised only on success: `LoadLayer.res.mjs:82` writes the output dict
 *    inside `.then(...)`, and a rejection takes the `.catch(onError)` branch
 *    instead, so nothing is recorded. A FAILED effect is therefore neither
 *    memoised nor deduped, while a returned sentinel is both. Throwing would
 *    turn one failed trace into 1 + N serial re-invocations — the swallowed
 *    preload attempt plus one per event sharing that transaction in the
 *    sequential pass — each paying the full retry ladder below, up to 8s of
 *    backoff. Returning `[]` costs one attempt for the whole batch — plus,
 *    since the preload prefetch, exactly one serial `getFeesAccruedRetry`
 *    ladder, which is the price of not trusting a `[]` taken mid-burst.
 *
 * An earlier version of this file rethrew transient errors with the comment
 * "let the runtime's own retry handle it". There is no such retry. Under
 * `envio dev`, which restarts the process, that turned one flaky RPC response
 * into a crash-restart loop that re-processed the same batch, hit the same
 * transaction, and died again — a chain pinned at zero events indefinitely,
 * which is exactly what was observed on Ethereum.
 *
 * So transient failures are retried HERE, with backoff, and exhaustion degrades
 * the same way a capability gap does. That is also Ponder's tested decision: it
 * warns and records zero for the one event rather than taking down the chain,
 * and its comment says so explicitly — "Trading one event's exact fee for
 * liveness, per design call."
 */
const TRANSIENT_BACKOFF_MS = [250, 750, 2000, 5000];

/**
 * Is this a PERMANENT trace-capability gap rather than a transient blip?
 *
 * The distinction is load-bearing: a permanent gap must degrade to "no collected
 * fee recorded" and warn, because without that guard a single -32601 from one
 * chain's RPC halts that chain's entire backfill. Capability gaps are common
 * across load-balanced provider pools that mix full and archive nodes.
 *
 * DIVERGENCE FROM PONDER, DELIBERATE, AND MEASURED. Ponder's version also
 * matches `msg.includes("tracer")`, and viem embeds the full request body in the
 * error message — and every `debug_traceTransaction` body contains
 * `"tracer":"callTracer"`. So in Ponder EVERY error on this call is classified
 * permanent, transient ones included, and silently records 0 collected fees.
 * That is not hypothetical: on mainnet, tokenId 926 shows 0 collected fees in
 * Ponder where the trace decodes to 333387.830400084026115227, and 686 has two
 * collects of which Ponder captured only the second.
 *
 * That substring is removed here, and the remaining phrases are ANCHORED rather
 * than bare — see the note at the regexes below for why a bare "not supported"
 * repeats Ponder's mistake in a quieter form.
 */
export function isTraceCapabilityError(e: unknown): boolean {
  const err = e as { code?: number; cause?: { code?: number; message?: string }; message?: string; details?: string };
  const code = err?.code ?? err?.cause?.code;
  if (code === -32601 || code === -32004) return true;
  const msg = String(err?.message ?? err?.details ?? err?.cause?.message ?? "").toLowerCase();

  // Unambiguous phrases: these only ever describe a missing method.
  if (
    msg.includes("method not found") ||
    msg.includes("method not supported") ||
    msg.includes("method does not exist")
  ) {
    return true;
  }

  /*
   * "not supported" and "unsupported" must be ANCHORED to the method, never
   * matched bare.
   *
   * Bare substrings are how this misfires. viem composes its error message from
   * the URL and the full request body, so the text being searched contains
   * arbitrary provider prose plus our own payload, and plenty of NON-capability
   * failures carry those words: rate-limit and plan-tier notices, pruning
   * messages ("state at block N is not available"), and load-balancer HTML.
   * Classifying any of those as permanent records ZERO collected fees for a
   * transaction that really settled one — and unlike a crash, that is a number
   * nobody can tell is wrong.
   *
   * Anchoring is also the specific trap Ponder fell into from the other
   * direction: it matches `msg.includes("tracer")`, and every
   * debug_traceTransaction body contains `"tracer":"callTracer"`, so EVERY
   * error there is "permanent". Requiring the words to sit next to `method` or
   * the method name — within a short window, so a mention anywhere in a long
   * body does not count — keeps a genuine "debug_traceTransaction is not
   * supported on your plan" (a real capability gap for this key) while
   * rejecting prose that merely contains the words.
   */
  const ANCHORED = [
    /\b(?:method|debug_tracetransaction)\b[^\n]{0,60}?\b(?:not supported|unsupported|not available|not enabled)\b/,
    /\b(?:not supported|unsupported|not enabled)\b[^\n]{0,60}?\b(?:method|debug_tracetransaction)\b/,
  ];
  return ANCHORED.some((re) => re.test(msg));
}

interface TraceNode {
  to?: string;
  input?: string;
  output?: string;
  error?: string;
  calls?: TraceNode[];
}

/**
 * One decoded `PoolManager.modifyLiquidity` call frame.
 *
 * `ordinal` IS THE PAIRING KEY, and it is the whole point of this shape. A
 * settlement transaction emits TWO ModifyLiquidity events for the SAME salt:
 * the first carries `feesAccrued`, the second carries (0, 0). Matching a
 * handler's event to its frame by salt alone therefore picks one of the two
 * arbitrarily — last-wins picked the zero, first-wins double-counts once both
 * events reach the trace. Matching on (salt, tickLower, tickUpper,
 * liquidityDelta) is also not enough: 35 Avalanche transactions carry two frames
 * identical in all four fields (tx 0x44e8625d81, position 43114_7842, among
 * them). Only the ORDINAL — 0-based position among frames sharing a salt, in
 * execution order — separates them.
 *
 * The ticks and the delta ride along NOT as the pairing key but as an INTEGRITY
 * CHECK: the handler asserts the frame it was handed describes the event it is
 * holding, and records zero rather than a guess when it does not.
 */
export interface ModifyFrame {
  /** Decimal string of the bytes32 salt — the NFT tokenId for a PositionManager call. */
  readonly salt: string;
  /** 0-based index among frames with this salt, in EXECUTION order. */
  readonly ordinal: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidityDelta: bigint;
  /** MAGNITUDES of `feesAccrued`. */
  readonly amount0: bigint;
  readonly amount1: bigint;
}

/** Every PoolManager.modifyLiquidity frame with a complete BalanceDelta output. */
function collectModifyCalls(node: TraceNode | undefined, acc: TraceNode[], poolManager: string): void {
  if (
    node &&
    typeof node.to === "string" &&
    node.to.toLowerCase() === poolManager &&
    typeof node.input === "string" &&
    node.input.toLowerCase().startsWith(MODIFY_LIQ_SELECTOR) &&
    typeof node.output === "string" &&
    // two int256 words of return data
    node.output.length >= 2 + 128
  ) {
    acc.push(node);
  }
  for (const c of node?.calls ?? []) collectModifyCalls(c, acc, poolManager);
}

/**
 * Decode a callTracer trace into ordered, ordinal-stamped `modifyLiquidity`
 * frames. PURE — no network, no context — so the replay harness can run the
 * exact production pairing against real traces.
 *
 * EXECUTION ORDER IS THE CONTRACT. `collectModifyCalls` walks the tree
 * depth-first, visiting a node before its children, which is the order the EVM
 * actually entered those calls; nothing here sorts or re-groups, and nothing may
 * start to. The pairing is only sound because the k-th same-salt PoolManager
 * ModifyLiquidity LOG is the k-th same-salt frame — verified across all 2,062
 * Avalanche settlement transactions, matching on (tickLower, tickUpper,
 * liquidityDelta, salt), 2062/2062 with zero exceptions.
 *
 * A frame whose calldata will not decode is SKIPPED, which shifts the ordinals
 * of later same-salt frames. It cannot be counted instead: a frame with no
 * readable salt cannot be assigned to a salt's sequence at all. The handler's
 * tick/delta integrity check is what catches the resulting mismatch, and it
 * records zero rather than the wrong frame's money. In practice the selector
 * filter above means the decode cannot fail.
 */
export function framesFromTrace(trace: TraceNode | undefined, poolManager: string): ModifyFrame[] {
  const calls: TraceNode[] = [];
  collectModifyCalls(trace, calls, poolManager.toLowerCase());

  const seenPerSalt = new Map<string, number>();
  const out: ModifyFrame[] = [];
  for (const c of calls) {
    let params: { tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: string };
    try {
      params = decodeFunctionData({
        abi: MODIFY_LIQ_ABI,
        data: c.input as `0x${string}`,
      }).args[1] as typeof params;
    } catch {
      continue;
    }
    const salt = BigInt(params.salt).toString();
    const ordinal = seenPerSalt.get(salt) ?? 0;
    seenPerSalt.set(salt, ordinal + 1);

    // feesAccrued is the SECOND return word: chars 66..130 of the output.
    const delta = decodeBalanceDelta(BigInt("0x" + (c.output as string).slice(66, 130)));
    out.push({
      salt,
      ordinal,
      tickLower: Number(params.tickLower),
      tickUpper: Number(params.tickUpper),
      liquidityDelta: BigInt(params.liquidityDelta),
      amount0: absBig(delta.amount0),
      amount1: absBig(delta.amount1),
    });
  }
  return out;
}

const clients: Record<number, PublicClient> = {};
function traceClient(chainId: number): PublicClient {
  if (!clients[chainId]) {
    clients[chainId] = createPublicClient({ transport: http(getRpcUrl(chainId)) });
  }
  return clients[chainId];
}

/**
 * Collected fees for EVERY `modifyLiquidity` frame of one transaction, in
 * execution order, each stamped with its per-salt ordinal.
 *
 * ONE ROW PER FRAME, NOT PER SALT. Keying the output by salt is exactly the
 * defect this shape exists to prevent: a settlement transaction routinely has
 * two same-salt frames, one carrying all the fees and one carrying (0, 0), and
 * any salt-keyed collapse silently keeps one of them.
 *
 * Returns the whole transaction rather than one position, so a batched
 * multi-position transaction costs exactly one trace and one cache entry. An
 * empty array means either no usable trace after retries or a permanent
 * capability gap — the caller records no collected fee and must NOT throw.
 *
 * Amounts are MAGNITUDES: `feesAccrued` is signed, a collected fee is not.
 *
 * WIDENING THIS SCHEMA IS SAFE AGAINST A WARM CACHE. A persisted row that no
 * longer parses is not a crash and not a silent zero: `LoadLayer.res.mjs:173-187`
 * catches the schema error, calls `recordInvalidation`, logs "Invalidated effect
 * cache" at trace level, and the input falls through to a fresh trace. So rows
 * written before `ordinal` existed are re-traced rather than mis-read.
 */
const FeesBySalt = S.array(
  S.schema({
    salt: S.string,
    ordinal: S.number,
    tickLower: S.number,
    tickUpper: S.number,
    liquidityDelta: S.bigint,
    amount0: S.bigint,
    amount1: S.bigint,
  }),
);

type FeesAccruedInput = { readonly txHash: string; readonly poolManager: string };
type FeesAccruedOutput = S.Output<typeof FeesBySalt>;

/**
 * The trace itself, shared by `getFeesAccrued` and `getFeesAccruedRetry`.
 *
 * ONE function behind TWO effects, and the reason is Envio's in-batch memo, not
 * style. `LoadManager.res:135` answers a real-pass call from the memo whenever
 * the key is present — and `InMemoryStore.setEffectOutput` stores the output
 * even when `context.cache = false` (it only skips the DB write). So once the
 * preload pass has prefetched a DEGRADED `[]` for a transaction, every later
 * `getFeesAccrued` call in that batch is served that `[]` without a new
 * attempt. A second effect NAME is a second memo, a second rate-limit window
 * and a second (never-created, since it is uncached) table, so the real pass
 * can re-trace through it. `createEffect` does not mutate its handler
 * (Envio.res:238-290), so sharing it is safe.
 */
async function traceFeesAccrued({
  context,
  input: { txHash, poolManager },
}: EffectArgs<FeesAccruedInput>): Promise<FeesAccruedOutput> {
  const chainId = context.chain.id;
  const pm = poolManager.toLowerCase();
  const client = traceClient(chainId);

  for (let attempt = 0; attempt < TRACE_MAX_ATTEMPTS; attempt++) {
    let trace: TraceNode;
    try {
      trace = (await client.request({
        method: "debug_traceTransaction",
        params: [txHash as `0x${string}`, { tracer: "callTracer" }],
      } as never)) as TraceNode;
    } catch (e) {
      if (isTraceCapabilityError(e)) {
        // DO NOT CACHE a degraded result. The cache is persisted and keyed on
        // the input, so caching this would make "no collected fee for this
        // transaction" permanent — surviving restarts and a full resync, and
        // indistinguishable from a genuine zero even after the RPC is fixed.
        // `context.cache = false` is the repo's existing idiom for exactly
        // this (src/utils/tokenMetadata.ts:131,207).
        context.cache = false;
        context.log.warn(
          `debug_traceTransaction/callTracer unsupported on chain ${chainId} — ` +
            `collected fees recorded as 0 for tx ${txHash}`,
        );
        return [];
      }
      // Transient. Retried HERE, never rethrown — see the note on
      // TRANSIENT_BACKOFF_MS: an uncaught throw in the sequential pass is a
      // fatal exit, and even where it is caught (the preload pass swallows
      // it) a failed effect is neither memoised nor deduped, so a throw
      // multiplies one bad trace into a serial retry storm.
      if (attempt < TRACE_MAX_ATTEMPTS - 1) {
        const waitMs = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]!;
        context.log.warn(
          `Trace attempt ${attempt + 1}/${TRACE_MAX_ATTEMPTS} failed for tx ${txHash} on chain ` +
            `${chainId} (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — ` +
            `retrying in ${waitMs}ms`,
        );
        await sleep(waitMs);
        continue;
      }
      // Exhausted. Degrade rather than exit, and do not cache the zero.
      context.cache = false;
      context.log.error(
        `All ${TRACE_MAX_ATTEMPTS} trace attempts failed for tx ${txHash} on chain ${chainId}: ` +
          `${e instanceof Error ? e.message.split("\n")[0] : String(e)} — recording 0 collected ` +
          `fees for this transaction. Re-run once the RPC is healthy to pick it up.`,
      );
      return [];
    }

    const frames = framesFromTrace(trace, pm);

    // Usable = the top call did not revert AND at least one modifyLiquidity
    // frame decoded with a full BalanceDelta output.
    if (!trace?.error && frames.length > 0) {
      return frames;
    }

    if (attempt < TRACE_MAX_ATTEMPTS - 1) await sleep(TRACE_RETRY_DELAY_MS);
  }

  // Same reasoning as the capability branch: an unusable trace is a statement
  // about the provider at this moment, not about the transaction, so it must
  // not be frozen into the cache as a measured zero.
  context.cache = false;
  context.log.warn(
    `No usable trace for tx ${txHash} on chain ${chainId} after ${TRACE_MAX_ATTEMPTS} ` +
      `attempts — collected fees recorded as 0`,
  );
  return [];
}

export const getFeesAccrued = createEffect(
  {
    name: "getFeesAccrued",
    // No `chainId`: the effect is chain-scoped, so the chain is already the cache
    // table and the .tsv directory. Carrying it in the key too only partitioned
    // rows INSIDE one file. Read from `context.chain.id` below.
    input: S.schema({
      txHash: S.string,
      poolManager: S.string,
    }),
    output: FeesBySalt,
    // Archive nodes are the scarce resource here and debug_traceTransaction is
    // the most expensive call in the indexer. A cached result means a given
    // transaction is traced once ever, even across a full resync.
    cache: true,
    rateLimit: { calls: 20, per: "second" },
    // Per-CHAIN rate limiting and cache, not global. `crossChain` defaults to
    // TRUE, which puts every chain through ONE shared rate-limit window — so
    // two chains backfilling in parallel contend for the same allowance and the
    // busier one starves. These inputs already carry `chainId` and each chain
    // has its own endpoint and its own quota, so a shared window bought nothing
    // but contention.
    crossChain: false,
  },
  traceFeesAccrued,
);

/**
 * The real pass's second attempt when `getFeesAccrued` came back EMPTY.
 *
 * `[]` is an exact failure signal, not a heuristic: every `return []` in
 * `traceFeesAccrued` sets `context.cache = false` (capability gap, exhausted
 * transient retries, no usable trace), and the only other return requires
 * `frames.length > 0`. The one deterministic `[]` — a capability gap, or a
 * `poolManager` that matches no frame — costs this retry one more attempt and
 * changes nothing.
 *
 * WHY IT EXISTS NOW. `getFeesAccrued` is prefetched in the PRELOAD pass, where
 * up to `rateLimit.calls` traces START per window per chain — with no cap on
 * how many are in flight — instead of the one the serial loop used to have. A provider 429 or tracer-timeout
 * burst therefore degrades far more traces at once, and a degraded `[]` is a
 * PERMANENT zero: `totalFeesCollected` only grows and a replay skips on the
 * watermark. This serial retry, under today's one-in-flight conditions, bounds
 * that loss to transactions that fail twice.
 *
 * NEVER CALL IT IN PRELOAD — that would recreate the burst it exists to escape.
 *
 * `cache: false`, deliberately. The primary cache is the authority; a success
 * persisted under this name would never be read by `getFeesAccrued` on a
 * resync (different table), so it would only add a table. An uncached effect
 * never creates one. The input and output are the SAME shapes as
 * `getFeesAccrued`'s and must stay so — the handler passes one input object to
 * both.
 */
export const getFeesAccruedRetry = createEffect(
  {
    name: "getFeesAccruedRetry",
    input: S.schema({
      txHash: S.string,
      poolManager: S.string,
    }),
    output: FeesBySalt,
    cache: false,
    rateLimit: { calls: 20, per: "second" },
    // Chain-scoped for the same reason as `getFeesAccrued`, and required:
    // `traceFeesAccrued` reads `context.chain.id`, which throws on a
    // cross-chain effect.
    crossChain: false,
  },
  traceFeesAccrued,
);
