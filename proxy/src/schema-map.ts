/*
 * Single source of truth for how the vanilla Uniswap v4 subgraph's schema maps
 * onto this Envio indexer's Hasura surface.
 *
 * Hand-written from uniswap-v4-indexer-envio/schema.graphql. Three Envio facts
 * drive everything here:
 *
 *  - Root fields are the entity name verbatim (Hasura.res:194 sets
 *    `custom_name` to the table name), so `pools` -> `Pool`, never `pools`.
 *  - A reference field is exposed as BOTH an object relationship (`pool`) and
 *    the FK scalar column (`pool_id`) — Table.res:119 appends `_id`.
 *  - Pool.token0/token1 are plain `String!` columns holding a complete
 *    `Token.id`, NOT relations. Nested selection on them needs a join.
 */

import type { IdClass } from "./ids.js";

/** GraphQL variable type Hasura expects for a column. */
export type Scalar = "String" | "numeric" | "Int" | "Boolean";

export interface FieldSpec {
  /** Hasura column/relationship name, when it differs from the subgraph's. */
  readonly column?: string;
  readonly scalar: Scalar;
  /** Set when the value is an entity id needing translation. */
  readonly idClass?: IdClass;
  /** Reference field: object relationship + `<name>_id` FK column. */
  readonly ref?: { readonly entity: string };
  /** Array relationship (@derivedFrom). */
  readonly list?: { readonly entity: string };
  /**
   * Pool.token0/token1: a String column holding a Token.id that the backend
   * selects as if it were a relation. Resolved by a batched join.
   */
  readonly tokenStitch?: true;
}

export interface EntitySpec {
  /** Hasura root field / table name. */
  readonly table: string;
  readonly idClass: IdClass;
  /** Entities carrying a `chainId` column that must be filtered on. */
  readonly chainScoped: boolean;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

const NUM: FieldSpec = { scalar: "numeric" };
const STR: FieldSpec = { scalar: "String" };
const INT: FieldSpec = { scalar: "Int" };

export const ENTITIES: Readonly<Record<string, EntitySpec>> = {
  Pool: {
    table: "Pool",
    idClass: "pool",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "pool" },
      chainId: NUM,
      name: STR,
      createdAtTimestamp: NUM,
      createdAtBlockNumber: NUM,
      token0: { scalar: "String", tokenStitch: true },
      token1: { scalar: "String", tokenStitch: true },
      feeTier: NUM,
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tickSpacing: NUM,
      observationIndex: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      feesUSD: NUM,
      feesUSDUntracked: NUM,
      txCount: NUM,
      collectedFeesToken0: NUM,
      collectedFeesToken1: NUM,
      collectedFeesUSD: NUM,
      totalValueLockedToken0: NUM,
      totalValueLockedToken1: NUM,
      totalValueLockedETH: NUM,
      totalValueLockedUSD: NUM,
      totalValueLockedUSDUntracked: NUM,
      liquidityProviderCount: NUM,
      hooks: STR,
      ticks: { scalar: "String", list: { entity: "Tick" } },
      poolDayData: { scalar: "String", list: { entity: "PoolDayData" } },
      poolHourData: { scalar: "String", list: { entity: "PoolHourData" } },
    },
  },
  Token: {
    table: "Token",
    idClass: "token",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "token" },
      chainId: NUM,
      symbol: STR,
      name: STR,
      decimals: NUM,
      totalSupply: NUM,
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      poolCount: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      totalValueLockedUSDUntracked: NUM,
      derivedETH: NUM,
      tokenDayData: { scalar: "String", list: { entity: "TokenDayData" } },
      tokenHourData: { scalar: "String", list: { entity: "TokenHourData" } },
    },
  },
  // Bundle has NO chainId column — its id IS the chain id.
  Bundle: {
    table: "Bundle",
    idClass: "bundle",
    chainScoped: false,
    fields: {
      id: { scalar: "String", idClass: "bundle" },
      ethPriceUSD: NUM,
    },
  },
  Tick: {
    table: "Tick",
    idClass: "tick",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "tick" },
      chainId: NUM,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      tickIdx: NUM,
      liquidityGross: NUM,
      liquidityNet: NUM,
      price0: NUM,
      price1: NUM,
      createdAtTimestamp: NUM,
      createdAtBlockNumber: NUM,
    },
  },
  PoolDayData: {
    table: "PoolDayData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      date: INT,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tvlUSD: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  PoolHourData: {
    table: "PoolHourData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      periodStartUnix: INT,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tvlUSD: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  TokenDayData: {
    table: "TokenDayData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      date: INT,
      token: { scalar: "String", ref: { entity: "Token" } },
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      priceUSD: NUM,
      feesUSD: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  TokenHourData: {
    table: "TokenHourData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      periodStartUnix: INT,
      token: { scalar: "String", ref: { entity: "Token" } },
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      priceUSD: NUM,
      feesUSD: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
};

export interface RootFieldSpec {
  readonly entity: string;
  /** `single` unwraps to `row ?? null`; `list` returns the array. */
  readonly kind: "single" | "list";
}

/*
 * Only the root fields the backend actually issues. Anything else is a hard
 * TranslationError rather than a silently-empty result — adding one is a line
 * here plus its EntitySpec above.
 */
export const ROOT_FIELDS: Readonly<Record<string, RootFieldSpec>> = {
  pools: { entity: "Pool", kind: "list" },
  pool: { entity: "Pool", kind: "single" },
  tokens: { entity: "Token", kind: "list" },
  token: { entity: "Token", kind: "single" },
  bundles: { entity: "Bundle", kind: "list" },
  bundle: { entity: "Bundle", kind: "single" },
  ticks: { entity: "Tick", kind: "list" },
  tick: { entity: "Tick", kind: "single" },
  poolDayDatas: { entity: "PoolDayData", kind: "list" },
  poolHourDatas: { entity: "PoolHourData", kind: "list" },
  tokenDayDatas: { entity: "TokenDayData", kind: "list" },
  tokenHourDatas: { entity: "TokenHourData", kind: "list" },
};

/** The Graph's where-suffix grammar -> Hasura comparison operators. */
export const WHERE_OPS: Readonly<Record<string, string>> = {
  "": "_eq",
  _not: "_neq",
  _gt: "_gt",
  _gte: "_gte",
  _lt: "_lt",
  _lte: "_lte",
  _in: "_in",
  _not_in: "_nin",
};

/** Longest-first so `_not_in` wins over `_in`, and `_gte` over `_gt`. */
export const WHERE_SUFFIXES: readonly string[] = Object.keys(WHERE_OPS)
  .filter((s) => s !== "")
  .sort((a, b) => b.length - a.length);

/** The Graph caps a page at 1000 rows and errors above it. Match that. */
export const MAX_FIRST = 1000;
/** The Graph's default page size when `first` is omitted. */
export const DEFAULT_FIRST = 100;
