/*
 * Donate handler for Uniswap v4 pools.
 *
 * `PoolManager.donate(key, amount0, amount1, hookData)` moves tokens from the
 * caller INTO the pool and credits them to the in-range LPs as fee growth
 * (v4-core `Pool.donate`, which adds to `feeGrowthGlobal`). Hooks and routers use
 * it to pay out fees, so a pool whose own LP fee is 0% can still pay its LPs.
 *
 * Until this handler existed the event was subscribed to (config.yaml) and then
 * dropped, which had two consequences:
 *
 *  1. Pool / Token / PoolManager / HookStats TVL left the donated tokens out. They
 *     really are in the pool: every Swap and ModifyLiquidity before the Donate
 *     was summed into `totalValueLocked*`, and nothing else ever adds these.
 *  2. A donation to a 0% pool showed up only on the positions that collected it
 *     (the ModifyLiquidity trace reads exact `feesAccrued`), with nothing on the
 *     pool to say where the money came from.
 *
 * WHAT IT DOES: adds the amounts to `totalValueLocked*` (pool, tokens,
 * PoolManager, HookStats), adds them to the pool's own `donatedToken0/1/USD`, and
 * writes a `Donation` row.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - It does not touch `feesUSD`, `collectedFees*` or any Day/Hour `feesUSD`.
 *    Those are swap fees priced at the swap's LP fee rate; a donation is not a
 *    fee on any swap, and folding it in would put a "fee" on a 0% pool again,
 *    this time on purpose. The two are separate columns so a consumer can add
 *    them if it wants LP income rather than swap fees.
 *  - It does not bump `txCount` or write Day/Hour rows. A hook usually donates
 *    inside the very transaction of the swap it is taxing, so counting it would
 *    double that transaction; the TVL snapshot on the Day/Hour rows is refreshed
 *    by the next Swap or ModifyLiquidity of the pool, which overwrites it.
 *
 * REPLAY: the TVL and donated totals are running sums, so a re-delivered range
 * would double them. The `Donation` row is the marker, exactly as `Swap` is for
 * swap-handler.ts: keyed on `chainId_blockNumber_logIndex`, written once, and
 * checked above the first write. See the note in modifyLiquidity-handler.ts.
 */
import { indexer } from "envio";
import { getChainConfig } from "../utils/chains";
import { convertTokenToDecimal } from "../utils";
import { sanitizeBD } from "../utils/index";

const NO_HOOK = "0x0000000000000000000000000000000000000000";

indexer.onEvent({ contract: "PoolManager", event: "Donate" }, async ({ event, context }) => {
  const chainConfig = getChainConfig(event.chainId);
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  const poolId = `${event.chainId}_${event.params.id}`;
  const donationId = `${event.chainId}_${event.block.number}_${event.logIndex}`;

  const pool = await context.Pool.get(poolId);
  // No Initialize seen for this pool (a skipped pool, or a range that started
  // after it): nothing to add the tokens to.
  if (!pool) {
    return;
  }

  const isHookedPool = pool.hooks !== NO_HOOK;
  const [poolManager, token0, token1, bundle, hookStats, applied] = await Promise.all([
    context.PoolManager.get(`${event.chainId}_${event.srcAddress}`),
    context.Token.get(pool.token0),
    context.Token.get(pool.token1),
    context.Bundle.get(event.chainId.toString()),
    isHookedPool ? context.HookStats.get(`${event.chainId}_${pool.hooks}`) : undefined,
    // The replay guard's own read, issued with the rest so the preload pass
    // groups it instead of costing a serialized SELECT in the sequential pass.
    context.Donation.get(donationId),
  ]);

  // Every set below is a no-op during preload; the reads above were the point.
  if (context.isPreload) {
    return;
  }
  // Same bail-out as ModifyLiquidity: without a price bundle the USD figures
  // would be written as 0 over good ones.
  if (!poolManager || !token0 || !token1 || !bundle) {
    return;
  }

  if (applied) {
    context.log.warn(
      `Donate ${donationId} has already been applied — skipping. This is a REPLAY: ` +
        `the indexer is re-processing a range it already committed, and the TVL and ` +
        `donated totals are not idempotent.`,
    );
    return;
  }

  // Unlike Swap, the amounts are unsigned and always flow INTO the pool.
  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // Priced at the tokens' stored derivedETH, as ModifyLiquidity prices its amounts.
  const amountUSD = sanitizeBD(
    amount0
      .times(token0.derivedETH)
      .plus(amount1.times(token1.derivedETH))
      .times(bundle.ethPriceUSD),
  );

  const previousTvlETH = pool.totalValueLockedETH;
  const previousTvlUSD = pool.totalValueLockedUSD;

  let nextPool = {
    ...pool,
    totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
    donatedToken0: pool.donatedToken0.plus(amount0),
    donatedToken1: pool.donatedToken1.plus(amount1),
    donatedUSD: sanitizeBD(pool.donatedUSD.plus(amountUSD)),
  };
  nextPool = {
    ...nextPool,
    totalValueLockedETH: nextPool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(nextPool.totalValueLockedToken1.times(token1.derivedETH)),
  };
  nextPool = {
    ...nextPool,
    totalValueLockedUSD: sanitizeBD(nextPool.totalValueLockedETH.times(bundle.ethPriceUSD)),
  };

  const nextToken0 = {
    ...token0,
    totalValueLocked: token0.totalValueLocked.plus(amount0),
  };
  const nextToken1 = {
    ...token1,
    totalValueLocked: token1.totalValueLocked.plus(amount1),
  };
  nextToken0.totalValueLockedUSD = nextToken0.totalValueLocked.times(
    token0.derivedETH.times(bundle.ethPriceUSD),
  );
  nextToken1.totalValueLockedUSD = nextToken1.totalValueLocked.times(
    token1.derivedETH.times(bundle.ethPriceUSD),
  );

  // Remove this pool's old TVL and add the new one, as every other handler does.
  const tvlETH = poolManager.totalValueLockedETH
    .minus(previousTvlETH)
    .plus(nextPool.totalValueLockedETH);
  const nextPoolManager = {
    ...poolManager,
    totalValueLockedETH: tvlETH,
    totalValueLockedUSD: tvlETH.times(bundle.ethPriceUSD),
  };

  if (hookStats) {
    context.HookStats.set({
      ...hookStats,
      totalValueLockedUSD: hookStats.totalValueLockedUSD
        .minus(previousTvlUSD)
        .plus(nextPool.totalValueLockedETH.times(bundle.ethPriceUSD)),
    });
  }

  context.Pool.set(nextPool);
  context.Token.set(nextToken0);
  context.Token.set(nextToken1);
  context.PoolManager.set(nextPoolManager);
  context.Donation.set({
    id: donationId,
    chainId: BigInt(event.chainId),
    transaction: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    pool: poolId,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    amount0,
    amount1,
    amountUSD,
    logIndex: BigInt(event.logIndex),
  });
});
