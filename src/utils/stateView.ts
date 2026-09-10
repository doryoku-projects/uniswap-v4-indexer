/*
 * On-chain reads for position fee tracking, via the Effect API.
 *
 * Two effects, with deliberately opposite caching:
 *
 *   getPositionInfoAt  — HISTORICAL, immutable  -> cache: true
 *     Read at the block of a ModifyLiquidity. Returns the contract's own
 *     `feeGrowthInsideLast` AFTER that block, which is exactly the value
 *     Position.update just used to compute feesAccrued. This is what replaces
 *     debug_traceTransaction.
 *
 *   refreshPositionState — LIVE, changes every block -> cache: false
 *     Read at head by the FeeSync block handler for uncollected fees and
 *     current amounts. Caching this would freeze the numbers forever.
 *
 * Both are `crossChain: false`: the result depends on the chain, so the cache
 * and rate limit are per-chain and `context.chain.id` is available inside.
 *
 * All uint256 values cross the effect boundary as decimal STRINGS. The effect
 * cache is a real database table, and a 256-bit integer does not fit a numeric
 * column safely.
 */
import { S, createEffect } from "envio";
import { createPublicClient, http, type PublicClient } from "viem";
import { STATE_VIEW_BY_CHAIN, rpcUrlFor } from "./positionAddresses";

// Minimal StateView surface — only what fee tracking needs.
export const StateViewAbi = [
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getFeeGrowthInside",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
    outputs: [
      { name: "feeGrowthInside0X128", type: "uint256" },
      { name: "feeGrowthInside1X128", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

// One client per chain. `batch: true` is load-bearing: the preload pass fires
// every position's effect concurrently, and batching collapses them into a few
// JSON-RPC requests instead of one request per read.
const clients = new Map<number, PublicClient>();
function clientFor(chainId: number): PublicClient | null {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const url = rpcUrlFor(chainId);
  if (!url) return null;
  // batch:true is kept because it reduces HTTP round trips, but note it does
  // NOT reduce billed request count: QuickNode (and most providers) meter each
  // sub-call in a JSON-RPC array separately — verified empirically, 20 batched
  // eth_calls in one POST still produced 5 "15/second request limit" errors.
  // The per-second budget is therefore enforced by the effects' `rateLimit`.
  const client = createPublicClient({
    // retryCount deliberately LOW. viem retries a 429 immediately, and each
    // retry is another billed request, so a high count turns one burst into a
    // self-amplifying storm against a per-second cap. Recovery is handled by
    // the effect's own backoff loop below, which paces properly.
    transport: http(url, { batch: true, retryCount: 1, retryDelay: 500 }),
  }) as PublicClient;
  clients.set(chainId, client);
  return client;
}

const PositionInfoSchema = S.schema({
  liquidity: S.string,
  feeGrowthInside0LastX128: S.string,
  feeGrowthInside1LastX128: S.string,
});

/**
 * The contract's stored position state AFTER `blockNumber`.
 *
 * `blockHash` is part of the input purely so the effect cache key changes if the
 * block is reorged out — the call itself goes by number. Without it a reorg
 * would serve a stale cached baseline and silently corrupt every later fee.
 */
export const getPositionInfoAt = createEffect(
  {
    name: "getPositionInfoAt",
    input: {
      blockNumber: S.number,
      blockHash: S.string,
      poolId: S.string,
      owner: S.string,
      tickLower: S.number,
      tickUpper: S.number,
      salt: S.string,
    },
    output: S.nullable(PositionInfoSchema),
    cache: true,
    // ONE eth_call per invocation, and the backfill's throughput ceiling.
    //
    // Budgeted well UNDER the plan's cap rather than close to it. viem retries a
    // 429, so each rate-limited call issues up to `retryCount` more requests —
    // a burst that touches the cap amplifies itself and can exhaust the retries,
    // which permanently invalidates that position's fee baseline. Measured on a
    // 15 req/s QuickNode plan: 9/s left 14 hard failures per 20k events, 6/s
    // left none. Measured on the current endpoint: 60 concurrent requests in
    // 356ms with zero failures. The current Dwellir archive endpoint measured
    // 40 req/s SUSTAINED over 8s with zero failures, so the budget is now
    // 24 (this) + 4 (token metadata) + 2 (batch refresh) = 30 req/s steady,
    // leaving 10 req/s of headroom for retries.
    rateLimit: { calls: 24, per: "second" },
    crossChain: false,
  },
  async ({ input, context }) => {
    const chainId = context.chain.id;
    const client = clientFor(chainId);
    const stateView = STATE_VIEW_BY_CHAIN[chainId];
    if (!client || !stateView) return null;

    // Giving up here is EXPENSIVE, not neutral: a null return marks the fee
    // baseline unverified, so the next successful settle books nothing and the
    // fees accrued in between are lost. A rate-limit blip must therefore be
    // retried with real backoff rather than surrendered. Measured: at 6 req/s
    // against a 15 req/s plan, bursts still produced ~10 hard failures per
    // 400k events without this loop.
    // Retry on ANY error, not a curated list. Matching on error TEXT already
    // failed once in production: the pattern covered QuickNode's
    // "15/second request limit reached" but not its other wording,
    // "account limited to 15/sec", so a rate-limited read gave up after one
    // attempt and lost that position's baseline. Since surrendering is the
    // expensive outcome and a genuinely permanent error just ends up in the
    // same place a few seconds later, the safe default is to always retry.
    // A longer backoff is used when the text does look rate-limit-shaped.
    const RATE_LIMITED = /limit|429|too many|exceed/i;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const [liquidity, fg0, fg1] = await client.readContract({
          abi: StateViewAbi,
          address: stateView as `0x${string}`,
          functionName: "getPositionInfo",
          args: [
            input.poolId as `0x${string}`,
            input.owner as `0x${string}`,
            input.tickLower,
            input.tickUpper,
            input.salt as `0x${string}`,
          ],
          blockNumber: BigInt(input.blockNumber),
        });
        return {
          liquidity: liquidity.toString(),
          feeGrowthInside0LastX128: fg0.toString(),
          feeGrowthInside1LastX128: fg1.toString(),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const last = attempt === 3;
        if (!last) {
          // Rate-limit-shaped errors need to clear the provider's 1s window;
          // anything else just needs a brief pause.
          const backoff = RATE_LIMITED.test(msg) ? 1500 * (attempt + 1) : 400;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        // Do NOT cache a failure — a pruned-state or transient error would
        // otherwise be frozen as "no fees" for this position forever.
        context.cache = false;
        context.log.warn(
          "getPositionInfo failed after retries; fee baseline marked unverified",
          {
            chainId,
            blockNumber: input.blockNumber,
            salt: input.salt,
            attempts: attempt + 1,
            error: msg,
          },
        );
        return null;
      }
    }
    return null;
  },
);

const LiveStateSchema = S.schema({
  sqrtPriceX96: S.string,
  tick: S.number,
  liquidity: S.string,
  feeGrowthInside0X128: S.string,
  feeGrowthInside1X128: S.string,
  feeGrowthInside0LastX128: S.string,
  feeGrowthInside1LastX128: S.string,
});

/**
 * Pool + position state for the uncollected-fee refresh: slot0, the range's
 * current feeGrowthInside, and the position's stored baseline — the three reads
 * Ponder's FeeSync batches through Multicall3.
 *
 * PINNED to `blockNumber`, which must be the block the handler is processing,
 * NOT the chain head. This is load-bearing and was a real bug when omitted:
 *
 *   - viem defaults to `latest`. The indexer cursor trails head (on a ~100ms
 *     chain, one round trip is several blocks), so an unpinned read returns
 *     state from the FUTURE relative to the row being written. Writing that
 *     `liquidity` back makes the next ModifyLiquidity double-apply its delta,
 *     and advancing the fee baseline past an unprocessed modify silently books
 *     that modify's collected fee as 0.
 *   - `context.chain.isRealtime` LATCHES (`CrossChainState.res:167` ORs it and
 *     never clears), so after any stall the cursor can trail head arbitrarily
 *     far while FeeSync keeps running. Pinning is the only thing that bounds it.
 *   - Pinning also makes the three reads mutually consistent. Unpinned they are
 *     three independent calls that can land on different blocks, so the
 *     in-range decision could disagree with the fee-growth values it gates.
 *
 * Not cached: the same (position, block) is never requested twice, and caching
 * would only bloat the cache table.
 */
const BatchItemSchema = S.schema({
  poolId: S.string,
  tickLower: S.number,
  tickUpper: S.number,
  salt: S.string,
});

/** Canonical Multicall3, same address on every chain that has it. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Batched live refresh: ONE eth_call for a whole slice of positions.
 *
 * This is what makes uncollected fees viable. The per-position version below
 * issues three eth_calls each, so refreshing ~2,600 active positions cost 7,788
 * requests — 43 minutes at the rate limit, against a 40-minute tick interval.
 * A pass could never finish before the next one began, so uncollected fees
 * would lag indefinitely. Aggregating through Multicall3 turns those 7,788
 * requests into roughly 26, which is the same trick Ponder's FeeSync uses.
 *
 * `getSlot0` is deduplicated per pool inside the batch: positions cluster
 * heavily into the same pools, so this alone removes most of the calls.
 *
 * Pinned to `blockNumber` for the same reason the single-position version is —
 * an unpinned read returns state from ahead of the indexer cursor.
 */
export const refreshPositionsBatch = createEffect(
  {
    name: "refreshPositionsBatch",
    input: {
      blockNumber: S.number,
      owner: S.string,
      items: S.array(BatchItemSchema),
    },
    // One entry per input item, in the same order. null = that position's reads
    // failed; the caller leaves its previous values alone.
    output: S.array(S.nullable(LiveStateSchema)),
    cache: false,
    rateLimit: { calls: 4, per: "second" },
    crossChain: false,
  },
  async ({ input, context }) => {
    const chainId = context.chain.id;
    const client = clientFor(chainId);
    const stateView = STATE_VIEW_BY_CHAIN[chainId];
    const empty = input.items.map(() => null);
    if (!client || !stateView) return empty;

    const base = { abi: StateViewAbi, address: stateView as `0x${string}` } as const;
    const pools = [...new Set(input.items.map((i) => i.poolId))];
    const poolIndex = new Map(pools.map((p, i) => [p, i]));

    const contracts = [
      ...pools.map((poolId) => ({
        ...base,
        functionName: "getSlot0" as const,
        args: [poolId as `0x${string}`],
      })),
      ...input.items.flatMap((i) => [
        {
          ...base,
          functionName: "getFeeGrowthInside" as const,
          args: [i.poolId as `0x${string}`, i.tickLower, i.tickUpper],
        },
        {
          ...base,
          functionName: "getPositionInfo" as const,
          args: [
            i.poolId as `0x${string}`,
            input.owner as `0x${string}`,
            i.tickLower,
            i.tickUpper,
            i.salt as `0x${string}`,
          ],
        },
      ]),
    ];

    let results: readonly { status: string; result?: unknown }[];
    try {
      results = (await client.multicall({
        contracts: contracts as never,
        allowFailure: true,
        blockNumber: BigInt(input.blockNumber),
        // The client is created without a `chain`, so viem cannot infer this.
        multicallAddress: MULTICALL3,
        // viem splits a multicall once calldata exceeds `batchSize` BYTES,
        // which would silently undo the batching. The slice size is bounded by
        // the caller instead, so raise this out of the way.
        batchSize: 10_000_000,
      })) as never;
    } catch (err) {
      context.log.warn("batched position refresh failed; leaving previous values", {
        chainId,
        blockNumber: input.blockNumber,
        positions: input.items.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }

    const nPools = pools.length;
    const val = (i: number) =>
      results[i]?.status === "success" ? (results[i]!.result as unknown[]) : null;

    return input.items.map((item, k) => {
      const slot0 = val(poolIndex.get(item.poolId)!);
      const fg = val(nPools + k * 2);
      const pos = val(nPools + k * 2 + 1);
      if (!slot0 || !fg || !pos) return null;
      return {
        sqrtPriceX96: String(slot0[0]),
        tick: Number(slot0[1]),
        liquidity: String(pos[0]),
        feeGrowthInside0X128: String(fg[0]),
        feeGrowthInside1X128: String(fg[1]),
        feeGrowthInside0LastX128: String(pos[1]),
        feeGrowthInside1LastX128: String(pos[2]),
      };
    });
  },
);

export const refreshPositionState = createEffect(
  {
    name: "refreshPositionState",
    input: {
      blockNumber: S.number,
      poolId: S.string,
      owner: S.string,
      tickLower: S.number,
      tickUpper: S.number,
      salt: S.string,
    },
    output: S.nullable(LiveStateSchema),
    cache: false,
    // THREE eth_calls per invocation, so 1/s = 3 req/s of the shared budget.
    rateLimit: { calls: 1, per: "second" },
    crossChain: false,
  },
  async ({ input, context }) => {
    const chainId = context.chain.id;
    const client = clientFor(chainId);
    const stateView = STATE_VIEW_BY_CHAIN[chainId];
    if (!client || !stateView) return null;

    const base = { abi: StateViewAbi, address: stateView as `0x${string}` } as const;
    const blockNumber = BigInt(input.blockNumber);
    try {
      const [slot0, fg, pos] = await Promise.all([
        client.readContract({
          ...base,
          functionName: "getSlot0",
          args: [input.poolId as `0x${string}`],
          blockNumber,
        }),
        client.readContract({
          ...base,
          functionName: "getFeeGrowthInside",
          args: [input.poolId as `0x${string}`, input.tickLower, input.tickUpper],
          blockNumber,
        }),
        client.readContract({
          ...base,
          functionName: "getPositionInfo",
          args: [
            input.poolId as `0x${string}`,
            input.owner as `0x${string}`,
            input.tickLower,
            input.tickUpper,
            input.salt as `0x${string}`,
          ],
          blockNumber,
        }),
      ]);
      return {
        sqrtPriceX96: slot0[0].toString(),
        tick: Number(slot0[1]),
        liquidity: pos[0].toString(),
        feeGrowthInside0X128: fg[0].toString(),
        feeGrowthInside1X128: fg[1].toString(),
        feeGrowthInside0LastX128: pos[1].toString(),
        feeGrowthInside1LastX128: pos[2].toString(),
      };
    } catch (err) {
      context.log.warn("position refresh failed; leaving previous values", {
        chainId,
        blockNumber: input.blockNumber,
        salt: input.salt,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
);
