import { describe, expect, it } from "vitest";

import { translate } from "../../src/graph-api/translate.js";
import { TranslationError } from "../../src/graph-api/errors.js";
import * as Q from "./fixtures.js";

const CHAIN = 1;
const SCHEMA = "ethereum";
const POOL = "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a";
const TOKEN = "0x31a519f6cf89d9a334e26808f3acb43c1d081c66";

const t = (src: string, vars: Record<string, unknown> = {}) =>
  translate(src, vars, CHAIN, SCHEMA);

/** Roots only, so a snapshot reads as SQL rather than nested JSON. */
function sqlOf(src: string, vars: Record<string, unknown> = {}) {
  const shape = t(src, vars).shape;
  if (shape.kind !== "roots") throw new Error("expected roots");
  return shape.roots.map((r) => ({ out: r.out, sql: r.sql, params: r.params }));
}

describe("root fields and arguments", () => {
  it("POOLS_QUERY: chain filter, id tiebreak, and the day-data list lifted to a batched plan", () => {
    const shape = t(Q.POOLS_QUERY, { first: 100, skip: 200 }).shape;
    if (shape.kind !== "roots") throw new Error("expected roots");
    const root = shape.roots[0]!;
    expect(root.sql).toMatchInlineSnapshot(`"SELECT "id", "token0", "token1", "feeTier", "tickSpacing", "tick", "sqrtPrice", "liquidity", "createdAtTimestamp", "totalValueLockedToken0", "totalValueLockedToken1", "totalValueLockedUSD", "volumeUSD", "feesUSD", "txCount", "token0Price", "token1Price" FROM "ethereum"."Pool" WHERE "chainId" = $1::numeric ORDER BY "volumeUSD" DESC, "id" ASC LIMIT $2 OFFSET $3"`);
    expect(root.params).toMatchInlineSnapshot(`
      [
        "1",
        100,
        200,
      ]
    `);
    // poolDayData is NOT inlined — it becomes one windowed follow-up query.
    expect(root.lists).toMatchInlineSnapshot(`
      [
        {
          "columns": [
            ""date"",
            ""volumeUSD"",
            ""feesUSD"",
            ""tvlUSD"",
          ],
          "entity": "PoolDayData",
          "fkColumn": "pool_id",
          "limit": 7,
          "orderBy": ""date" DESC",
          "outKey": "poolDayData",
          "row": {
            "entity": "PoolDayData",
            "fields": [
              {
                "coerce": "int",
                "kind": "scalar",
                "out": "date",
                "src": "date",
              },
              {
                "coerce": "numericString",
                "kind": "scalar",
                "out": "volumeUSD",
                "src": "volumeUSD",
              },
              {
                "coerce": "numericString",
                "kind": "scalar",
                "out": "feesUSD",
                "src": "feesUSD",
              },
              {
                "coerce": "numericString",
                "kind": "scalar",
                "out": "tvlUSD",
                "src": "tvlUSD",
              },
            ],
          },
        },
      ]
    `);
  });

  it("VANILLA_POOLS_QUERY: an _in list becomes = ANY(...::text[]) with prefixed ids", () => {
    expect(sqlOf(Q.VANILLA_POOLS_QUERY, { ids: [POOL, "0xabc"] })).toMatchInlineSnapshot(`
      [
        {
          "out": "pools",
          "params": [
            "{"1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a","1_0xabc"}",
            "1",
            1000,
          ],
          "sql": "SELECT "id", "totalValueLockedUSD", "totalValueLockedUSDUntracked", "totalValueLockedToken0", "totalValueLockedToken1", "volumeUSD", "feesUSD" FROM "ethereum"."Pool" WHERE "id" = ANY($1::text[]) AND "chainId" = $2::numeric LIMIT $3",
        },
      ]
    `);
  });

  it("POOL_DAY_QUERY: the ref field filters on pool_id", () => {
    expect(sqlOf(Q.POOL_DAY_QUERY, { pool: POOL, fromDate: 1735689600 })).toMatchInlineSnapshot(`
      [
        {
          "out": "poolDayDatas",
          "params": [
            "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
            1735689600,
            "1",
            1000,
          ],
          "sql": "SELECT "date", "tick", "token0Price", "token1Price", "open", "high", "low", "close", "tvlUSD", "volumeUSD", "feesUSD" FROM "ethereum"."PoolDayData" WHERE "pool_id" = $1 AND "date" >= $2 AND "chainId" = $3::numeric ORDER BY "date" ASC LIMIT $4",
        },
      ]
    `);
  });

  it("TICKS_QUERY: a string bound against a numeric column is cast explicitly", () => {
    expect(sqlOf(Q.TICKS_QUERY, { pool: POOL })).toMatchInlineSnapshot(`
      [
        {
          "out": "ticks",
          "params": [
            "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
            "0",
            "1",
            1000,
          ],
          "sql": "SELECT "tickIdx", "liquidityGross", "liquidityNet", "price0", "price1" FROM "ethereum"."Tick" WHERE "pool_id" = $1 AND "liquidityGross" > $2::numeric AND "chainId" = $3::numeric ORDER BY "tickIdx" ASC LIMIT $4",
        },
      ]
    `);
  });

  it("POOL_STATE_QUERY: pool(id:) becomes a filtered LIMIT 1", () => {
    expect(sqlOf(Q.POOL_STATE_QUERY, { pool: POOL })).toMatchInlineSnapshot(`
      [
        {
          "out": "pool",
          "params": [
            "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
            "1",
            1,
          ],
          "sql": "SELECT "tick", "sqrtPrice", "tickSpacing", "token0", "token1" FROM "ethereum"."Pool" WHERE "id" = $1 AND "chainId" = $2::numeric LIMIT $3",
        },
      ]
    `);
  });

  it("CURRENT_PRICES_QUERY: bundles is pinned by id because Bundle has no chainId column", () => {
    expect(sqlOf(Q.CURRENT_PRICES_QUERY, { ids: [TOKEN] })).toMatchInlineSnapshot(`
      [
        {
          "out": "bundles",
          "params": [
            "1",
            1,
          ],
          "sql": "SELECT "ethPriceUSD" FROM "ethereum"."Bundle" WHERE "id" = $1 LIMIT $2",
        },
        {
          "out": "tokens",
          "params": [
            "{"1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66"}",
            "1",
            100,
          ],
          "sql": "SELECT "id", "derivedETH" FROM "ethereum"."Token" WHERE "id" = ANY($1::text[]) AND "chainId" = $2::numeric LIMIT $3",
        },
      ]
    `);
  });

  it("TOKEN_HOUR_PRICES_QUERY: cursor id_gt survives and token { id } collapses to the FK", () => {
    expect(
      sqlOf(Q.TOKEN_HOUR_PRICES_QUERY, {
        tokens: [TOKEN],
        hours: [1768478400],
        first: 1000,
        lastId: "",
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "out": "tokenHourDatas",
          "params": [
            "{"1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66"}",
            "{"1768478400"}",
            "",
            "1",
            1000,
          ],
          "sql": "SELECT "id", "periodStartUnix", "priceUSD", "token_id" FROM "ethereum"."TokenHourData" WHERE "token_id" = ANY($1::text[]) AND "periodStartUnix" = ANY($2::text[]) AND "id" > $3 AND "chainId" = $4::numeric ORDER BY "id" ASC LIMIT $5",
        },
      ]
    `);
  });

  it("LATEST_HOUR_PRICE_QUERY", () => {
    expect(sqlOf(Q.LATEST_HOUR_PRICE_QUERY, { token: TOKEN, hourLte: 1768478400 })).toMatchInlineSnapshot(`
      [
        {
          "out": "tokenHourDatas",
          "params": [
            "1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
            1768478400,
            "1",
            1,
          ],
          "sql": "SELECT "periodStartUnix", "priceUSD" FROM "ethereum"."TokenHourData" WHERE "token_id" = $1 AND "periodStartUnix" <= $2 AND "chainId" = $3::numeric ORDER BY "periodStartUnix" DESC LIMIT $4",
        },
      ]
    `);
  });

  it("META_QUERY needs no entity SQL at all", () => {
    expect(t(Q.META_QUERY).shape).toEqual({ kind: "meta" });
  });
});

describe("nullable ordering", () => {
  it("spells out null placement when sorting on tick", () => {
    const [root] = sqlOf(`{ pools(orderBy: tick, orderDirection: desc, first: 5) { id } }`);
    expect(root!.sql).toContain("DESC NULLS FIRST");
  });
});

describe("injection surface", () => {
  it("binds every caller value as a parameter, never as SQL text", () => {
    const evil = "'; DROP TABLE \"Pool\"; --";
    const [root] = sqlOf(`query Q($p: String!) { pools(where: { id: $p }, first: 1) { id } }`, {
      p: evil,
    });
    expect(root!.sql).not.toContain("DROP");
    expect(root!.params).toContain(`1_${evil}`);
  });

  it("every statement binds at least one parameter, so the simple protocol is never reached", () => {
    // postgres.js only allows multi-statement payloads on the simple protocol.
    for (const src of [
      Q.POOLS_QUERY,
      Q.POOL_DAY_QUERY,
      Q.TICKS_QUERY,
      Q.CURRENT_PRICES_QUERY,
    ]) {
      const vars = { first: 1, skip: 0, pool: POOL, fromDate: 0, ids: [TOKEN] };
      for (const r of sqlOf(src, vars)) expect(r.params.length).toBeGreaterThan(0);
    }
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
    ["more than { id } on a reference field", `{ ticks(first: 1) { pool { id feeTier } } }`],
    ["a filter on a nested list", `{ pools(first: 1) { poolDayData(where: { date_gt: 0 }, first: 1) { date } } }`],
  ];
  for (const [name, src] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => t(src)).toThrow(TranslationError);
    });
  }

  it("never emits a message the backend would mistake for a transient gateway fault", () => {
    // ponder-compatible.adapter.ts retries HTTP-200 errors matching this.
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
