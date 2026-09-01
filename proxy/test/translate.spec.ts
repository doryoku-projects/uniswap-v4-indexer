import { describe, expect, it } from "vitest";

import { translate } from "../src/translate.js";
import { TranslationError } from "../src/errors.js";
import * as Q from "./fixtures.js";

const CHAIN = 1;
const POOL = "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a";
const TOKEN = "0x31a519f6cf89d9a334e26808f3acb43c1d081c66";

const t = (src: string, vars: Record<string, unknown> = {}) =>
  translate(src, vars, CHAIN);

describe("root fields and arguments", () => {
  it("POOLS_QUERY: injects the chain filter, an id tiebreak, and translates ordering/pagination", () => {
    const p = t(Q.POOLS_QUERY, { first: 100, skip: 200 });
    expect(p.query).toMatchInlineSnapshot(`
      "query TopPools($p0: numeric!, $p1: Int!, $p2: Int!, $p3: Int!) {
        pools: Pool(where: { chainId: { _eq: $p0 } }, order_by: [{ volumeUSD: desc }, { id: asc }], limit: $p1, offset: $p2) { id token0 token1 feeTier tickSpacing tick sqrtPrice liquidity createdAtTimestamp totalValueLockedToken0 totalValueLockedToken1 totalValueLockedUSD volumeUSD feesUSD txCount token0Price token1Price poolDayData(order_by: [{ date: desc }], limit: $p3) { date volumeUSD feesUSD tvlUSD } }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1",
        "p1": 100,
        "p2": 200,
        "p3": 7,
      }
    `);
  });

  it("VANILLA_POOLS_QUERY: prefixes every id in an _in list", () => {
    const p = t(Q.VANILLA_POOLS_QUERY, { ids: [POOL, "0xabc"] });
    expect(p.query).toMatchInlineSnapshot(`
      "query VanillaPools($p0: [String!]!, $p1: numeric!, $p2: Int!) {
        pools: Pool(where: { id: { _in: $p0 }, chainId: { _eq: $p1 } }, limit: $p2) { id totalValueLockedUSD totalValueLockedUSDUntracked totalValueLockedToken0 totalValueLockedToken1 volumeUSD feesUSD }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": [
          "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
          "1_0xabc",
        ],
        "p1": "1",
        "p2": 1000,
      }
    `);
  });

  it("POOL_DAY_QUERY: ref field becomes pool_id and Int stays Int", () => {
    const p = t(Q.POOL_DAY_QUERY, { pool: POOL, fromDate: 1735689600 });
    expect(p.query).toMatchInlineSnapshot(`
      "query PoolDay($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        poolDayDatas: PoolDayData(where: { pool_id: { _eq: $p0 }, date: { _gte: $p1 }, chainId: { _eq: $p2 } }, order_by: [{ date: asc }], limit: $p3) { date tick token0Price token1Price open high low close tvlUSD volumeUSD feesUSD }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": 1735689600,
        "p2": "1",
        "p3": 1000,
      }
    `);
  });

  it("TOKEN_DAY_QUERY", () => {
    const p = t(Q.TOKEN_DAY_QUERY, { token: TOKEN, fromDate: 1735689600 });
    expect(p.query).toMatchInlineSnapshot(`
      "query TokenDay($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        tokenDayDatas: TokenDayData(where: { token_id: { _eq: $p0 }, date: { _gte: $p1 }, chainId: { _eq: $p2 } }, order_by: [{ date: asc }], limit: $p3) { date priceUSD }
      }"
    `);
  });

  it("TICKS_QUERY: liquidityGross_gt keeps its string value against a numeric column", () => {
    const p = t(Q.TICKS_QUERY, { pool: POOL });
    expect(p.query).toMatchInlineSnapshot(`
      "query Ticks($p0: String!, $p1: numeric!, $p2: numeric!, $p3: Int!) {
        ticks: Tick(where: { pool_id: { _eq: $p0 }, liquidityGross: { _gt: $p1 }, chainId: { _eq: $p2 } }, order_by: [{ tickIdx: asc }], limit: $p3) { tickIdx liquidityGross liquidityNet price0 price1 }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": "0",
        "p2": "1",
        "p3": 1000,
      }
    `);
  });

  it("POOL_STATE_QUERY: pool(id:) becomes a filtered limit-1 list", () => {
    const p = t(Q.POOL_STATE_QUERY, { pool: POOL });
    expect(p.query).toMatchInlineSnapshot(`
      "query PoolState($p0: String!, $p1: numeric!, $p2: Int!) {
        pool: Pool(where: { id: { _eq: $p0 }, chainId: { _eq: $p1 } }, limit: $p2) { tick sqrtPrice tickSpacing token0 token1 }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": "1",
        "p2": 1,
      }
    `);
  });

  it("CURRENT_PRICES_QUERY: bundles is pinned by id because Bundle has no chainId column", () => {
    const p = t(Q.CURRENT_PRICES_QUERY, { ids: [TOKEN] });
    expect(p.query).toMatchInlineSnapshot(`
      "query CurrentPrices($p0: String!, $p1: Int!, $p2: [String!]!, $p3: numeric!, $p4: Int!) {
        bundles: Bundle(where: { id: { _eq: $p0 } }, limit: $p1) { ethPriceUSD }
        tokens: Token(where: { id: { _in: $p2 }, chainId: { _eq: $p3 } }, limit: $p4) { id derivedETH }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1",
        "p1": 1,
        "p2": [
          "1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
        ],
        "p3": "1",
        "p4": 100,
      }
    `);
  });

  it("TOKEN_HOUR_PRICES_QUERY: cursor id_gt and token { id } collapse to the FK column", () => {
    const p = t(Q.TOKEN_HOUR_PRICES_QUERY, {
      tokens: [TOKEN],
      hours: [1768478400],
      first: 1000,
      lastId: "",
    });
    expect(p.query).toMatchInlineSnapshot(`
      "query TokenHourPrices($p0: [String!]!, $p1: [Int!]!, $p2: String!, $p3: numeric!, $p4: Int!) {
        tokenHourDatas: TokenHourData(where: { token_id: { _in: $p0 }, periodStartUnix: { _in: $p1 }, id: { _gt: $p2 }, chainId: { _eq: $p3 } }, order_by: [{ id: asc }], limit: $p4) { id periodStartUnix priceUSD token_id }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": [
          "1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
        ],
        "p1": [
          1768478400,
        ],
        "p2": "",
        "p3": "1",
        "p4": 1000,
      }
    `);
  });

  it("LATEST_HOUR_PRICE_QUERY", () => {
    const p = t(Q.LATEST_HOUR_PRICE_QUERY, { token: TOKEN, hourLte: 1768478400 });
    expect(p.query).toMatchInlineSnapshot(`
      "query LatestHourPrice($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        tokenHourDatas: TokenHourData(where: { token_id: { _eq: $p0 }, periodStartUnix: { _lte: $p1 }, chainId: { _eq: $p2 } }, order_by: [{ periodStartUnix: desc }], limit: $p3) { periodStartUnix priceUSD }
      }"
    `);
  });

  it("META_QUERY: emits its own three-root document", () => {
    const p = t(Q.META_QUERY);
    expect(p.query).toMatchInlineSnapshot(`
      "query ProxyMeta($p0: Int!, $p1: numeric!) {
        meta: _meta(where: { chainId: { _eq: $p0 } }, limit: 1) { progressBlock }
        sw: Swap(where: { chainId: { _eq: $p1 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
        ml: ModifyLiquidity(where: { chainId: { _eq: $p1 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": 1,
        "p1": "1",
      }
    `);
  });
});

describe("nullable ordering", () => {
  it("spells out null placement when sorting on tick", () => {
    const p = t(`{ pools(orderBy: tick, orderDirection: desc, first: 5) { id } }`);
    expect(p.query).toContain("desc_nulls_first");
  });
});

describe("refusals", () => {
  const cases: Array<[string, string]> = [
    ["unknown root field", `{ swaps(first: 1) { id } }`],
    ["unknown column", `{ pools(first: 1) { nope } }`],
    ["unsupported where suffix", `{ pools(where: { id_contains: "a" }, first: 1) { id } }`],
    ["time travel", `{ pools(block: { number: 100 }, first: 1) { id } }`],
    ["oversized page", `{ pools(first: 5000) { id } }`],
    ["orderDirection without orderBy", `{ pools(orderDirection: desc, first: 1) { id } }`],
    ["fragments", `{ pools(first: 1) { ...F } } fragment F on Pool { id }`],
    ["scalar with a selection set", `{ pools(first: 1) { feeTier { x } } }`],
  ];
  for (const [name, src] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => t(src)).toThrow(TranslationError);
    });
  }

  it("never emits a message the backend would mistake for a transient gateway fault", () => {
    // ponder-compatible.adapter.ts:890 retries HTTP-200 errors matching this.
    const RE = /bad indexers|no attestation|indexing_error|too far behind|unavailable/i;
    for (const [, src] of cases) {
      try {
        t(src);
      } catch (e) {
        expect(RE.test((e as Error).message)).toBe(false);
      }
    }
  });
});
