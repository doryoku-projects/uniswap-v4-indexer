/*
 * Initialize event handlers for Uniswap v4 pools
 */

import { indexer, BigDecimal, type Pool } from "envio";
import { getChainConfig } from "../utils/chains";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { getTokenMetadata } from "../utils/tokenMetadata";
import { findNativePerToken } from "../utils/pricing";
import { sanitizeBD } from "../utils";
import {
  preloadIntervalData,
  updatePoolDayData,
  updatePoolHourData,
} from "../utils/intervalUpdates";

indexer.onEvent({ contract: "PoolManager", event: "Initialize" }, async ({ event, context }) => {
  // Get chain config for whitelist tokens and pools to skip
  const chainConfig = getChainConfig(event.chainId);

  // Check if this pool should be skipped (similar to subgraph implementation)
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  /*
   * REPLAY GUARD. A restart can resume from a checkpoint BEHIND the last
   * commit and re-deliver a range that was already applied — observed
   * 2026-09-16 on chain 4663. NOT a torn batch commit: envio 3.7.0 pushes
   * `Checkpoints.insert` onto the same `setOperations` array as the entity
   * writes and awaits them inside one `Postgres.beginSql`
   * (`PgStorage.res:1249-1303`); only `updatedEffectsCache` is outside, and
   * says so. Cause unestablished; what is certain is that re-delivery happens
   * and nothing is rolled back.
   *
   * THIS HANDLER IS THE DESTRUCTIVE ONE. It does not accumulate into the Pool
   * row — it OVERWRITES it with a fresh zeroed literal (`liquidity: 0n`,
   * `txCount: 0n`, zeroed volume/TVL/collectedFees) and rewinds `tick` and
   * `sqrtPrice` to the initialize values. Re-running it therefore does not
   * double a pool, it ERASES one.
   *
   * And nothing puts it back. `modifyLiquidity-handler.ts` wraps its own
   * `Pool.set` in `if (!replayed)` and `swap-handler.ts` returns outright, so
   * once those two see the replay they decline to re-accumulate onto the row
   * this handler just zeroed. `tick`, `sqrtPrice` and `liquidity` do recover —
   * `swap-handler.ts` ASSIGNS all three from event params, so the first Swap
   * after the replay window heals them, and until it arrives the rewound values
   * feed `currentAmounts` for every position in the pool and the fee sweep's
   * in-range partition. Permanently lost are the accumulated fields the same
   * write leaves untouched: `txCount`, `volumeToken0/1`, `volumeUSD`, `feesUSD`,
   * `collectedFees*`, `totalValueLocked*`, `liquidityProviderCount`.
   *
   * WHY THE POOL ROW IS THE MARKER. `Initialize` fires exactly once per pool on
   * chain, and this is the ONLY handler that creates a Pool row — the other two
   * `Pool.set` sites both read the row first and bail when it is absent
   * (`modifyLiquidity-handler.ts:73` `if (!existingPool) return;`, and swap
   * reads it at :25). So an existing row means this event has already been
   * applied. No separate marker entity is needed.
   *
   * Placed ABOVE the PoolManager/HookStats/Token reads on purpose: those three
   * are `+ 1n` accumulators (`poolCount`, `numberOfPools`, `hookedPools`) and
   * two of them write before the preload return, so a guard further down would
   * let the counters double even when the Pool row was spared.
   *
   * Real pass only. Every `set` is a no-op during preload, so there is nothing
   * to protect there, and returning early would skip the token and interval
   * warming the real pass depends on.
   */
  const alreadyInitialized = await context.Pool.get(
    `${event.chainId}_${event.params.id}`
  );
  if (alreadyInitialized && !context.isPreload) {
    context.log.warn(
      `Initialize ${event.chainId}_${event.params.id} has already been applied — skipping. ` +
        `This is a REPLAY: the indexer is re-processing a range it already committed. ` +
        `Re-running this handler would overwrite the pool with a zeroed row and ` +
        `re-increment poolCount/numberOfPools.`,
    );
    return;
  }

  // Define isHookedPool at the start
  const isHookedPool =
    event.params.hooks !== "0x0000000000000000000000000000000000000000";

  let poolManager = await context.PoolManager.get(
    `${event.chainId}_${event.srcAddress}`
  );
  if (!poolManager) {
    poolManager = {
      id: `${event.chainId}_${event.srcAddress}`,
      chainId: BigInt(event.chainId),
      poolCount: 1n,
      txCount: 0n,
      totalVolumeUSD: new BigDecimal(0),
      totalVolumeETH: new BigDecimal(0),
      totalFeesUSD: new BigDecimal(0),
      totalFeesETH: new BigDecimal(0),
      untrackedVolumeUSD: new BigDecimal(0),
      totalValueLockedUSD: new BigDecimal(0),
      totalValueLockedETH: new BigDecimal(0),
      totalValueLockedUSDUntracked: new BigDecimal(0),
      totalValueLockedETHUntracked: new BigDecimal(0),
      owner: event.srcAddress,
      numberOfSwaps: 0n,
      hookedPools: 0n,
      hookedSwaps: 0n,
    };
    context.Bundle.set({
      id: event.chainId.toString(),
      ethPriceUSD: new BigDecimal("0"),
    });
  } else {
    poolManager = {
      ...poolManager,
      poolCount: poolManager.poolCount + 1n,
    };
  }

  // Update or create HookStats if this is a hooked pool
  if (isHookedPool) {
    poolManager = {
      ...poolManager,
      hookedPools: poolManager.hookedPools + 1n,
    };

    const hookStatsId = `${event.chainId}_${event.params.hooks}`;
    let hookStats = await context.HookStats.get(hookStatsId);

    if (!hookStats) {
      hookStats = {
        id: hookStatsId,
        chainId: BigInt(event.chainId),
        numberOfPools: 0n,
        numberOfSwaps: 0n,
        firstPoolCreatedAt: BigInt(event.block.timestamp),
        totalValueLockedUSD: new BigDecimal("0"),
        totalVolumeUSD: new BigDecimal("0"),
        untrackedVolumeUSD: new BigDecimal("0"),
        totalFeesUSD: new BigDecimal("0"),
      };
    }

    hookStats = {
      ...hookStats,
      numberOfPools: hookStats.numberOfPools + 1n,
    };

    context.HookStats.set(hookStats);
  }

  // Create or get token0
  const token0Id = `${event.chainId}_${event.params.currency0.toLowerCase()}`;
  let token0 = await context.Token.get(token0Id);
  if (!token0) {
    const metadata = await context.effect(
      getTokenMetadata,
      event.params.currency0,
    );
    token0 = {
      id: token0Id,
      chainId: BigInt(event.chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      decimalsResolved: metadata.decimalsResolved,
      totalSupply: 0n,
      volume: new BigDecimal("0"),
      volumeUSD: new BigDecimal("0"),
      untrackedVolumeUSD: new BigDecimal("0"),
      feesUSD: new BigDecimal("0"),
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: new BigDecimal("0"),
      totalValueLockedUSD: new BigDecimal("0"),
      totalValueLockedUSDUntracked: new BigDecimal("0"),
      derivedETH: new BigDecimal("0"),
      whitelistPools: [], // Initialize empty array
    };
  } else {
    token0 = {
      ...token0,
      poolCount: token0.poolCount + 1n,
    };
  }

  // Create or get token1
  const token1Id = `${event.chainId}_${event.params.currency1.toLowerCase()}`;
  let token1 = await context.Token.get(token1Id);
  if (!token1) {
    const metadata = await context.effect(
      getTokenMetadata,
      event.params.currency1,
    );
    token1 = {
      id: token1Id,
      chainId: BigInt(event.chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      decimalsResolved: metadata.decimalsResolved,
      totalSupply: 0n,
      volume: new BigDecimal("0"),
      volumeUSD: new BigDecimal("0"),
      untrackedVolumeUSD: new BigDecimal("0"),
      feesUSD: new BigDecimal("0"),
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: new BigDecimal("0"),
      totalValueLockedUSD: new BigDecimal("0"),
      totalValueLockedUSDUntracked: new BigDecimal("0"),
      derivedETH: new BigDecimal("0"),
      whitelistPools: [], // Initialize empty array
    };
  } else {
    token1 = {
      ...token1,
      poolCount: token1.poolCount + 1n,
    };
  }

  // Update whitelist pools first
  if (
    chainConfig.whitelistTokens.includes(event.params.currency0.toLowerCase())
  ) {
    token1 = {
      ...token1,
      whitelistPools: [
        ...token1.whitelistPools,
        `${event.chainId}_${event.params.id}`,
      ],
    };
  }

  if (
    chainConfig.whitelistTokens.includes(event.params.currency1.toLowerCase())
  ) {
    token0 = {
      ...token0,
      whitelistPools: [
        ...token0.whitelistPools,
        `${event.chainId}_${event.params.id}`,
      ],
    };
  }

  // Now update derivedETH values
  token0 = {
    ...token0,
    derivedETH: sanitizeBD(
      await findNativePerToken(
        context,
        token0,
        chainConfig.wrappedNativeAddress,
        chainConfig.stablecoinAddresses,
        chainConfig.minimumNativeLocked
      )
    ),
  };

  token1 = {
    ...token1,
    derivedETH: sanitizeBD(
      await findNativePerToken(
        context,
        token1,
        chainConfig.wrappedNativeAddress,
        chainConfig.stablecoinAddresses,
        chainConfig.minimumNativeLocked
      )
    ),
  };

  if (context.isPreload) {
    // Warm the interval rows here - see the note in swap-handler.ts.
    await preloadIntervalData(context, {
      blockTimestamp: event.block.timestamp,
      chainId: event.chainId,
      poolId: `${event.chainId}_${event.params.id}`,
    });
    return;
  }

  // Calculate initial prices
  const prices = sqrtPriceX96ToTokenPrices(
    event.params.sqrtPriceX96,
    token0,
    token1,
    chainConfig.nativeTokenDetails
  );

  const feeBps = Number(event.params.fee) / 10000; // Convert to percentage (fee is in bps)
  const poolName = `${token0.symbol} / ${token1.symbol} - ${feeBps}%`;

  // Create new pool with prices.
  // NOTE: hoisted into a named const (was an inline literal) so the interval
  // updates below can snapshot it - there is no `pool` local otherwise.
  const pool: Pool = {
    id: `${event.chainId}_${event.params.id}`,
    chainId: BigInt(event.chainId),
    name: poolName,
    createdAtTimestamp: BigInt(event.block.timestamp),
    createdAtBlockNumber: BigInt(event.block.number),
    token0: token0Id,
    token1: token1Id,
    feeTier: BigInt(event.params.fee),
    liquidity: 0n,
    sqrtPrice: event.params.sqrtPriceX96,
    token0Price: prices[0],
    token1Price: prices[1],
    tick: event.params.tick,
    tickSpacing: BigInt(event.params.tickSpacing),
    observationIndex: 0n,
    volumeToken0: new BigDecimal(0),
    volumeToken1: new BigDecimal(0),
    volumeUSD: new BigDecimal(0),
    untrackedVolumeUSD: new BigDecimal(0),
    feesUSD: new BigDecimal("0"),
    feesUSDUntracked: new BigDecimal("0"),
    txCount: 0n,
    collectedFeesToken0: new BigDecimal(0),
    collectedFeesToken1: new BigDecimal(0),
    collectedFeesUSD: new BigDecimal(0),
    totalValueLockedToken0: new BigDecimal(0),
    totalValueLockedToken1: new BigDecimal(0),
    totalValueLockedETH: new BigDecimal(0),
    totalValueLockedUSD: new BigDecimal(0),
    totalValueLockedUSDUntracked: new BigDecimal(0),
    liquidityProviderCount: 0n,
    hooks: event.params.hooks,
  };
  context.Pool.set(pool);

  // ---- interval data ----
  // Initialize seeds only the pool day/hour buckets - no token and no protocol
  // rollup - matching v4-subgraph/src/mappings/poolManager.ts:196-197.
  // Both buckets get txCount = 1 while Pool.txCount is still 0; that is what
  // the subgraph does (intervalUpdates.ts:76).
  await Promise.all([
    updatePoolDayData(context, pool, event.block.timestamp),
    updatePoolHourData(context, pool, event.block.timestamp),
  ]);

  context.PoolManager.set(poolManager);
  context.Token.set(token0);
  context.Token.set(token1);
});
