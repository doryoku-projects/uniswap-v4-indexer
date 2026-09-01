/*
 * The documents the tickwise backend actually sends, copied byte-exact from
 * source. A formatting change on the backend that alters the emitted Hasura
 * document should show up here as a failing diff, not as a production surprise.
 */

// backend/src/sync/pools-sync.service.ts:10
export const POOLS_QUERY = `
  query TopPools($first: Int!, $skip: Int!) {
    pools(
      orderBy: volumeUSD
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      token0 {
        id
        symbol
        decimals
      }
      token1 {
        id
        symbol
        decimals
      }
      feeTier
      tickSpacing
      tick
      sqrtPrice
      liquidity
      createdAtTimestamp
      totalValueLockedToken0
      totalValueLockedToken1
      totalValueLockedUSD
      volumeUSD
      feesUSD
      txCount
      token0Price
      token1Price
      poolDayData(orderBy: date, orderDirection: desc, first: 7) {
        date
        volumeUSD
        feesUSD
        tvlUSD
      }
    }
  }
`;

// backend/src/subgraph/adapters/ponder-compatible.adapter.ts:163
// The `#` comment lines are transmitted verbatim by graphql-request's gql tag.
export const VANILLA_POOLS_QUERY = `
  query VanillaPools($ids: [ID!]!) {
    # first: 1000 — The Graph defaults to 100 rows; a positions page can touch
    # far more unique pools, and silently-missing stats disable the
    # realizability check for those pools (how a $8M full-supply launch LP
    # initially slipped through).
    pools(where: { id_in: $ids }, first: 1000) {
      id
      totalValueLockedUSD
      totalValueLockedUSDUntracked
      totalValueLockedToken0
      totalValueLockedToken1
      volumeUSD
      feesUSD
    }
  }
`;

// backend/src/charts/charts.service.ts:117
export const POOL_DAY_QUERY = `
  query PoolDay($pool: String!, $fromDate: Int!) {
    poolDayDatas(
      where: { pool: $pool, date_gte: $fromDate }
      orderBy: date
      orderDirection: asc
      first: 1000
    ) {
      date
      tick
      token0Price
      token1Price
      open
      high
      low
      close
      tvlUSD
      volumeUSD
      feesUSD
    }
  }
`;

// backend/src/charts/charts.service.ts:140
export const TOKEN_DAY_QUERY = `
  query TokenDay($token: String!, $fromDate: Int!) {
    tokenDayDatas(
      where: { token: $token, date_gte: $fromDate }
      orderBy: date
      orderDirection: asc
      first: 1000
    ) {
      date
      priceUSD
    }
  }
`;

// backend/src/charts/charts.service.ts:154
export const TICKS_QUERY = `
  query Ticks($pool: String!) {
    ticks(
      where: { pool: $pool, liquidityGross_gt: "0" }
      orderBy: tickIdx
      orderDirection: asc
      first: 1000
    ) {
      tickIdx
      liquidityGross
      liquidityNet
      price0
      price1
    }
  }
`;

// backend/src/charts/charts.service.ts:171
export const POOL_STATE_QUERY = `
  query PoolState($pool: String!) {
    pool(id: $pool) {
      tick
      sqrtPrice
      tickSpacing
      token0 {
        decimals
      }
      token1 {
        decimals
      }
    }
  }
`;

// backend/src/pricing/providers/subgraph-current.provider.ts:15
export const CURRENT_PRICES_QUERY = `
  query CurrentPrices($ids: [ID!]!) {
    bundles(first: 1) { ethPriceUSD }
    tokens(where: { id_in: $ids }) { id derivedETH }
  }
`;

// backend/src/pricing/providers/subgraph-historical.provider.ts:394
export const TOKEN_HOUR_PRICES_QUERY = `query TokenHourPrices($tokens: [String!]!, $hours: [Int!]!, $first: Int!, $lastId: String!) {
  tokenHourDatas(
    first: $first,
    orderBy: id,
    orderDirection: asc,
    where: { token_in: $tokens, periodStartUnix_in: $hours, id_gt: $lastId }
  ) {
    id
    periodStartUnix
    priceUSD
    token { id }
  }
}`;

// backend/src/pricing/providers/subgraph-historical.provider.ts:309
export const LATEST_HOUR_PRICE_QUERY = `query LatestHourPrice($token: String!, $hourLte: Int!) {
  tokenHourDatas(
    first: 1,
    orderBy: periodStartUnix,
    orderDirection: desc,
    where: { token: $token, periodStartUnix_lte: $hourLte }
  ) {
    periodStartUnix
    priceUSD
  }
}`;

// backend/src/sync/live-event-listener.service.ts:16
export const META_QUERY = `
  query Meta {
    _meta {
      block {
        number
        timestamp
      }
    }
  }
`;
