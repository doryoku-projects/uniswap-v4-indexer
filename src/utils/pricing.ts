import { BigDecimal, type EvmOnEventContext, type Pool, type Token } from "envio";

import { safeDiv } from "../utils/index";

type handlerContext = EvmOnEventContext;
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, ZERO_BI } from "./constants";
import { NativeTokenDetails } from "./nativeTokenDetails";

const Q192 = BigInt(2) ** BigInt(192);

/**
 * Significant digits kept by `exactRatio`. 30 is well past what any consumer
 * reads (the deepest is USD volume at cent scale) and far short of the ~131k
 * digits Postgres `numeric` accepts, so it is chosen for headroom, not fit.
 */
const RATIO_SIGNIFICANT_DIGITS = 30;

/**
 * Decimal places `exactRatio` keeps REGARDLESS of magnitude, so the change that
 * introduced it cannot lose precision anywhere.
 *
 * Significant digits alone are not enough. `safeDiv` rounded at 20 decimal
 * PLACES, which for a large value is many more than 30 significant digits — at
 * magnitude 1e26 it kept about 47. Capping at significant digits alone therefore
 * traded a gain at the small end for a LOSS at the large end: an audit measured
 * a `token1Price` going from `…339.89968117276218483191` to `…339.899`.
 *
 * Taking the max of the two rules means the result is never coarser than the old
 * behaviour at any magnitude — 30 significant digits where the value is small,
 * and at least the old 20 decimal places where it is large.
 */
const RATIO_MIN_DECIMAL_PLACES = 20;

/**
 * `numerator / denominator` to a fixed number of SIGNIFICANT digits.
 *
 * WHY NOT `safeDiv`. `BigDecimal` is bignumber.js at the default
 * `DECIMAL_PLACES = 20`, and that is twenty decimal PLACES, not twenty
 * significant digits. A quotient whose true value is below ~5e-21 therefore
 * rounds to a hard 0 no matter how exact its operands are — the precision you
 * get depends on the answer's magnitude rather than on the inputs.
 *
 * That is the real cause of the zeroed prices here, and reordering the division
 * does not escape it: for a pool whose `token1Price` is ~1e22, the reciprocal is
 * ~1e-22 and `safeDiv` returns 0 in either direction. Measured on the Avalanche
 * snapshot at block 60,970,065, six pools stored 0 against a representable truth
 * between 1e-24 and 2.9e-51, and those zeros propagated into 26 OHLC candle rows
 * where `low = 0` reads as "no data" rather than "very small".
 *
 * Both operands arrive here as EXACT integers, so the quotient is computed by
 * integer division after scaling by whatever power of ten keeps
 * `RATIO_SIGNIFICANT_DIGITS` of them, and the scale is carried in the exponent.
 * Precision is then relative to the value, which is the property a price needs.
 */
function exactRatio(numerator: bigint, denominator: bigint): BigDecimal {
  if (numerator === 0n || denominator === 0n) return ZERO_BD;

  // Base-10 magnitude of the quotient, to within one digit. Digit counts are
  // exact for positive integers, and both operands are positive here.
  const magnitude = numerator.toString().length - denominator.toString().length;
  const shift = Math.max(
    RATIO_MIN_DECIMAL_PLACES,
    RATIO_SIGNIFICANT_DIGITS - magnitude
  );

  const scaled = (numerator * 10n ** BigInt(shift)) / denominator;

  /*
   * Defensive only — `scaled` cannot actually be 0.
   *
   * `magnitude` is within one digit of `log10(numerator/denominator)` by
   * construction, and `shift` is at least `30 - magnitude`, so the quotient
   * always lands around 10^29..10^31 at the small end and larger above it. An
   * audit brute-forced 392,784 operand pairs across the whole v4 sqrtPrice
   * domain and decimals 0..24 in both directions: zero false zeros, minimum 30
   * significant digits.
   *
   * Kept rather than deleted because it is the only thing standing between a
   * future change to either constant and a silent 0 — the exact failure this
   * function exists to remove.
   */
  if (scaled === 0n) return ZERO_BD;

  /*
   * The final `/` is BigInt floor division, so both legs are biased LOW by under
   * one unit in the last place — unlike `safeDiv`, which rounded half-up. A
   * visible consequence: `price0 * price1` is always marginally under 1 rather
   * than straddling it. Nothing consumes that product, so this is a note, not a
   * defect; it is recorded because "more precise" and "rounding-neutral" are
   * different claims and only the first is true here.
   */
  return new BigDecimal(`${scaled}e-${shift}`);
}

export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: bigint,
  token0: Token,
  token1: Token,
  nativeTokenDetails: NativeTokenDetails
): [BigDecimal, BigDecimal] {
  const token0Decimals =
    token0.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token0.decimals;
  const token1Decimals =
    token1.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token1.decimals;

  /*
   * Build an EXACT integer numerator and denominator, then divide ONCE.
   *
   * This used to divide first and rescale afterwards:
   *
   *   num.div(denom).times(10^dec0).div(10^dec1)
   *
   * `div` is bignumber.js at the default 20 decimal places, so that first
   * division is where the value is quantized — and for a mismatched-decimal
   * pair the raw `sqrtPrice^2 / 2^192` ratio is nowhere near 1. An 18/6 pair
   * sits around 1e-15, which leaves only five or six significant digits after
   * rounding at 20 dp; the later `times(10^12)` then scales that error back up
   * with it. Measured on the Avalanche snapshot: 69 of 1123 pools' `token1Price`
   * and 84 of 1123 `token0Price` drifted 1e-6 to 7e-5 relative, and 22 of 32
   * pools stored 0 for a genuinely non-zero price.
   *
   * Folding the decimal scaling into the operands keeps everything exact up to
   * a single final division, which then rounds at 20 dp of the ANSWER rather
   * than of an intermediate that is 15 orders of magnitude off.
   *
   * `price0` is likewise computed by swapping the operands rather than as
   * `1 / price1`. Inverting a value that has already been rounded — or worse,
   * already underflowed to 0 — reintroduces exactly the defect above, and is
   * the same mistake that was storing `Tick.price1 = 0`; see the note in
   * `src/utils/tick.ts`.
   *
   * Swapping alone is NOT sufficient, which an audit of the first version of
   * this fix established: `safeDiv` rounds at 20 decimal PLACES, so a quotient
   * under ~5e-21 is zeroed whichever way the operands are ordered. Six pools
   * still stored 0 against a representable truth. Hence `exactRatio`, which
   * divides the exact integers to a fixed number of SIGNIFICANT digits — see
   * its own note above.
   */
  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** token0Decimals;
  const denominator = Q192 * 10n ** token1Decimals;

  // Both directions from the exact integers. An uninitialized pool has
  // `sqrtPriceX96 == 0`, so the numerator is 0 and both legs return 0.
  const price1 = exactRatio(numerator, denominator);
  const price0 = exactRatio(denominator, numerator);
  return [price0, price1];
}

export async function getNativePriceInUSD(
  context: handlerContext,
  chainId: string,
  stablecoinWrappedNativePoolId: string,
  stablecoinIsToken0: boolean
): Promise<BigDecimal> {
  const poolId = `${chainId}_${stablecoinWrappedNativePoolId}`;
  const stablecoinWrappedNativePool = await context.Pool.get(poolId);

  if (stablecoinWrappedNativePool) {
    return stablecoinIsToken0
      ? stablecoinWrappedNativePool.token0Price
      : stablecoinWrappedNativePool.token1Price;
  }
  return ZERO_BD;
}

/**
 * A pool may only set a token's price when the value it implies for the token
 * side is consistent with the pool's verifiable (whitelisted) side.
 *
 * The bound is empirical, not an AMM invariant — v4 concentrated liquidity
 * legitimately allows lopsided pools (one-sided range orders, wide-range
 * launch overhangs valued at spot). Measured across all organically traded
 * one-sided pools on the production indexer (2,584 pools with >=500 txs above
 * the pricing threshold, 2026-07-14): 96% sit below 10x, 99.6% below 100x,
 * 99.9% below 1000x, and NONE between 1e4x and 1e6x — while every observed
 * poison pool sits at 7.6e3x-1e24x. 1000x cuts through the empty band with
 * ~7x margin to the nearest junk and one-in-a-thousand impact on real pools.
 * Without this guard an attacker passes minimumNativeLocked with ~1 ETH, sets
 * an absurd price with one swap, and (optionally) withdraws — freezing a junk
 * derivedETH that inflates TVL/volume USD everywhere the token appears. With
 * it, faking $X of value requires depositing ~$X/1000 of real capital.
 */
export const MAX_PRICING_POOL_VALUE_IMBALANCE = new BigDecimal("1000");

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export async function findNativePerToken(
  context: handlerContext,
  token: Token,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumNativeLocked: BigDecimal
): Promise<BigDecimal> {
  const tokenAddress = token.id.split("_")[1]!;
  const chainId = token.id.split("_")[0]!; // Make sure this is being used for Bundle lookup

  if (tokenAddress == wrappedNativeAddress || tokenAddress == ADDRESS_ZERO) {
    return ONE_BD;
  }

  const whiteList = token.whitelistPools;
  let largestLiquidityETH = ZERO_BD;
  let priceSoFar = ZERO_BD;

  const bundle = await context.Bundle.get(chainId);
  if (!bundle) return ZERO_BD;

  if (stablecoinAddresses.includes(tokenAddress)) {
    priceSoFar = safeDiv(ONE_BD, bundle.ethPriceUSD);
  } else {
    // Pool IDs already include chainId since we store them that way in whitelistPools
    const pools = await Promise.all(
      whiteList.map((poolAddress) => context.Pool.get(poolAddress))
    );

    const tokenFetches: {
      pool: Pool;
      tokenId: string;
      isToken0: boolean;
    }[] = [];
    for (const pool of pools) {
      if (pool && pool.liquidity > ZERO_BI) {
        const poolToken0 = pool.token0.split("_")[1];
        const poolToken1 = pool.token1.split("_")[1];
        if (poolToken0 == tokenAddress) {
          tokenFetches.push({ pool, tokenId: pool.token1, isToken0: false });
        }
        if (poolToken1 == tokenAddress) {
          tokenFetches.push({ pool, tokenId: pool.token0, isToken0: true });
        }
      }
    }
    const tokens = await Promise.all(
      tokenFetches.map((f) => context.Token.get(f.tokenId))
    );

    for (const [i, { pool, isToken0 }] of tokenFetches.entries()) {
      const token = tokens[i];
      if (token) {
        const ethLocked = isToken0
          ? pool.totalValueLockedToken0.times(token.derivedETH)
          : pool.totalValueLockedToken1.times(token.derivedETH);
        const candidatePrice = isToken0
          ? pool.token0Price.times(token.derivedETH)
          : pool.token1Price.times(token.derivedETH);
        // Value the candidate price implies for OUR token's side of the pool.
        // Reject prices that value it far beyond the pool's verifiable side —
        // see MAX_PRICING_POOL_VALUE_IMBALANCE.
        const ourSideBalance = isToken0
          ? pool.totalValueLockedToken1
          : pool.totalValueLockedToken0;
        const impliedOurSideETH = ourSideBalance.times(candidatePrice);
        /*
         * A ZERO balance of the token being priced fails the bound, rather than
         * satisfying it vacuously.
         *
         * `impliedOurSideETH` is `ourSideBalance * candidatePrice`, so at a zero
         * balance it is 0 — and `0 <= anything` is always true. The guard then
         * waves through ANY price, at the one time it can verify nothing: the
         * pool holds none of the token whose value is in question. That breaks
         * the bound's stated premise (`MAX_PRICING_POOL_VALUE_IMBALANCE`, above)
         * that faking $X of value costs ~$X/1000 of real capital — at a zero
         * balance the multiplier is unbounded and the cost is zero.
         *
         * A one-sided pool is NORMAL in concentrated liquidity: a range entirely
         * out of range holds a single token. So this fires on ordinary pools, not
         * just manipulated ones, which is exactly why it has to be handled
         * rather than assumed away.
         *
         * This was latent until `sqrtPriceX96ToTokenPrices` stopped inverting an
         * already-rounded price. Before, an extreme-tick pool's `token0Price`
         * rounded to 0, so `candidatePrice` was 0 and the poisoned `derivedETH`
         * was 0 too — harmless by accident. With the price now computed exactly,
         * `1.0001^887272` is ~3.4e38 and reaches `derivedETH`, from where it
         * inflates `totalValueLockedETH/USD` for EVERY pool holding that token,
         * plus the PoolManager totals, the day/hour rollups and `Swap.amountUSD`.
         *
         * Rejecting should also be better than the old zero: the old code still
         * took this branch and set `priceSoFar = 0` AND raised
         * `largestLiquidityETH`, which can block a smaller, honest pool from
         * pricing the token at all. Failing the bound leaves both untouched.
         *
         * BUT THAT SECOND BENEFIT IS UNOBSERVED, and the distinction is worth
         * keeping honest. Over blocks 56,195,376-60,970,065 there are 31
         * whitelist entries pointing at a pool holding zero of the token being
         * priced — so the branch had 31 chances to matter — and the guard changed
         * no token's `derivedETH` from 0 to a real price. Both versions end at 0
         * for all 31, because the old code's `priceSoFar = 0` reached the same
         * place by a worse route. The poisoning this guard prevents is a proved
         * MECHANISM, not a repaired observation: no pool in that range paired a
         * zero balance with an extreme-tick price. Treat it as defensive.
         */
        const withinImbalanceBound =
          ourSideBalance.gt(ZERO_BD) &&
          impliedOurSideETH.lte(ethLocked.times(MAX_PRICING_POOL_VALUE_IMBALANCE));
        if (
          ethLocked.gt(largestLiquidityETH) &&
          ethLocked.gt(minimumNativeLocked) &&
          withinImbalanceBound
        ) {
          largestLiquidityETH = ethLocked;
          priceSoFar = candidatePrice;
        }
      }
    }
  }
  return priceSoFar;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export async function getTrackedAmountUSD(
  context: handlerContext,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  chainId: string,
  whitelistTokens: string[]
): Promise<BigDecimal> {
  const bundle = await context.Bundle.get(chainId);
  if (!bundle) return ZERO_BD;

  const price0USD = token0.derivedETH.times(bundle.ethPriceUSD);
  const price1USD = token1.derivedETH.times(bundle.ethPriceUSD);

  // Strip chainId prefix from token ids for whitelist comparison
  const token0Address = token0.id.split("_")[1]!;
  const token1Address = token1.id.split("_")[1]!;

  // both are whitelist tokens, return sum of both amounts
  if (
    whitelistTokens.includes(token0Address) &&
    whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD));
  }

  // take double value of the whitelisted token amount
  if (
    whitelistTokens.includes(token0Address) &&
    !whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount0.times(price0USD).times(new BigDecimal("2"));
  }

  // take double value of the whitelisted token amount
  if (
    !whitelistTokens.includes(token0Address) &&
    whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount1.times(price1USD).times(new BigDecimal("2"));
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD;
}

export function calculateAmountUSD(
  amount0: BigDecimal,
  amount1: BigDecimal,
  token0DerivedETH: BigDecimal,
  token1DerivedETH: BigDecimal,
  ethPriceUSD: BigDecimal
): BigDecimal {
  return amount0
    .times(token0DerivedETH.times(ethPriceUSD))
    .plus(amount1.times(token1DerivedETH.times(ethPriceUSD)));
}
