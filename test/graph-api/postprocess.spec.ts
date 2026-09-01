import { describe, expect, it } from "vitest";

import { makeIdCodec } from "../../src/graph-api/ids.js";
import { shapeMeta, shapeRoot, type Row } from "../../src/graph-api/postprocess.js";
import { translate } from "../../src/graph-api/translate.js";
import { UpstreamShapeError } from "../../src/graph-api/errors.js";
import * as Q from "./fixtures.js";

const CHAIN = 1;
const SCHEMA = "ethereum";
const POOL = "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a";
const T0 = "0x31a519f6cf89d9a334e26808f3acb43c1d081c66";
const T1 = "0xaecaf33b3892a9eac2ac9ef9df69e0516510ac4f";

const tokens = new Map<string, Row>([
  [`1_${T0}`, { id: `1_${T0}`, symbol: "AAA", decimals: "18" }],
  [`1_${T1}`, { id: `1_${T1}`, symbol: "BBB", decimals: "6" }],
]);

function ctx(over: Partial<{ tokens: Map<string, Row>; lists: Map<string, Row[]> }> = {}) {
  return {
    ids: makeIdCodec(CHAIN),
    chainId: CHAIN,
    loadTokens: async (ids: readonly string[]) =>
      new Map([...(over.tokens ?? tokens)].filter(([k]) => ids.includes(k))),
    loadList: async () => over.lists ?? new Map<string, Row[]>(),
  };
}

function rootOf(src: string, vars: Record<string, unknown> = {}) {
  const shape = translate(src, vars, CHAIN, SCHEMA).shape;
  if (shape.kind !== "roots") throw new Error("expected roots");
  return shape.roots[0]!;
}

describe("response reshaping", () => {
  it("strips the chain prefix, stitches tokens, and attaches the batched day rows", async () => {
    const root = rootOf(Q.POOLS_QUERY, { first: 2, skip: 0 });
    const out = await shapeRoot(
      root,
      [
        {
          id: `1_${POOL}`,
          token0: `1_${T0}`,
          token1: `1_${T1}`,
          feeTier: "500",
          tickSpacing: "10",
          tick: "-29959",
          sqrtPrice: "17715796892483574839390870793",
          liquidity: "7635099351093484",
          createdAtTimestamp: "1768435200",
          totalValueLockedToken0: "1.5",
          totalValueLockedToken1: "2.5",
          totalValueLockedUSD: "200219",
          volumeUSD: "18490000",
          feesUSD: "9242.51",
          txCount: "4",
          token0Price: "20.0003",
          token1Price: "0.04999",
        },
      ],
      ctx({
        lists: new Map([
          [`1_${POOL}`, [{ date: 1768435200, volumeUSD: "1", feesUSD: "2", tvlUSD: "3" }]],
        ]),
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "createdAtTimestamp": "1768435200",
          "feeTier": "500",
          "feesUSD": "9242.51",
          "id": "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
          "liquidity": "7635099351093484",
          "poolDayData": [
            {
              "date": 1768435200,
              "feesUSD": "2",
              "tvlUSD": "3",
              "volumeUSD": "1",
            },
          ],
          "sqrtPrice": "17715796892483574839390870793",
          "tick": "-29959",
          "tickSpacing": "10",
          "token0": {
            "decimals": "18",
            "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
            "symbol": "AAA",
          },
          "token0Price": "20.0003",
          "token1": {
            "decimals": "6",
            "id": "0xaecaf33b3892a9eac2ac9ef9df69e0516510ac4f",
            "symbol": "BBB",
          },
          "token1Price": "0.04999",
          "totalValueLockedToken0": "1.5",
          "totalValueLockedToken1": "2.5",
          "totalValueLockedUSD": "200219",
          "txCount": "4",
          "volumeUSD": "18490000",
        },
      ]
    `);
  });

  it("gives a pool with no day rows an empty array, not null", async () => {
    const root = rootOf(Q.POOLS_QUERY, { first: 1, skip: 0 });
    const out = (await shapeRoot(
      root,
      [{ id: `1_${POOL}`, token0: `1_${T0}`, token1: `1_${T1}` }],
      ctx({ lists: new Map() }),
    )) as Row[];
    expect(out[0]!.poolDayData).toEqual([]);
  });

  it("unwraps a singular root, and yields null when absent", async () => {
    const root = rootOf(Q.POOL_STATE_QUERY, { pool: POOL });
    expect(
      await shapeRoot(root, [{ tick: "-29959", sqrtPrice: "1771", tickSpacing: "10", token0: `1_${T0}`, token1: `1_${T1}` }], ctx()),
    ).toMatchInlineSnapshot(`
      {
        "sqrtPrice": "1771",
        "tick": "-29959",
        "tickSpacing": "10",
        "token0": {
          "decimals": "18",
        },
        "token1": {
          "decimals": "6",
        },
      }
    `);
    expect(await shapeRoot(root, [], ctx())).toBeNull();
  });

  it("re-expands the FK column into token { id } in subgraph id format", async () => {
    const root = rootOf(Q.TOKEN_HOUR_PRICES_QUERY, {
      tokens: [T0],
      hours: [1768478400],
      first: 10,
      lastId: "",
    });
    expect(
      await shapeRoot(
        root,
        [{ id: `1_${T0}_491244`, periodStartUnix: 1768478400, priceUSD: "1791.94", token_id: `1_${T0}` }],
        ctx(),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66-491244",
          "periodStartUnix": 1768478400,
          "priceUSD": "1791.94",
          "token": {
            "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
          },
        },
      ]
    `);
  });

  it("reports Bundle.id back as the subgraph's canonical '1'", async () => {
    const root = rootOf(`{ bundles(first: 1) { id ethPriceUSD } }`);
    expect(await shapeRoot(root, [{ id: "1", ethPriceUSD: "1791.94" }], ctx())).toEqual([
      { id: "1", ethPriceUSD: "1791.94" },
    ]);
  });

  it("refuses a row whose id lacks the chain prefix rather than passing it through", async () => {
    const root = rootOf(`{ pools(first: 1) { id } }`);
    await expect(shapeRoot(root, [{ id: "0xdeadbeef" }], ctx())).rejects.toThrow(UpstreamShapeError);
  });

  it("refuses a pool whose token row is missing instead of emitting a half-built object", async () => {
    const root = rootOf(`{ pools(first: 1) { id token0 { symbol } } }`);
    await expect(
      shapeRoot(root, [{ id: `1_${POOL}`, token0: "1_0xmissing" }], ctx({ tokens: new Map() })),
    ).rejects.toThrow(UpstreamShapeError);
  });
});

describe("numeric fidelity", () => {
  it("keeps a uint256 exact rather than routing it through a JS number", async () => {
    const root = rootOf(`{ pools(first: 1) { liquidity } }`);
    const huge = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const out = (await shapeRoot(root, [{ liquidity: huge }], ctx())) as Row[];
    expect(out[0]!.liquidity).toBe(huge);
  });

  it("rejects a numeric that already arrived as a lossy float", async () => {
    const root = rootOf(`{ pools(first: 1) { liquidity } }`);
    await expect(shapeRoot(root, [{ liquidity: 1e30 }], ctx())).rejects.toThrow(/precision/);
  });
});

describe("_meta shim", () => {
  it("maps progressBlock to block.number and uses the newest event as the timestamp", () => {
    expect(
      shapeMeta({ progressBlock: 24240020, latestEventTimestamp: "1768478831" }, ctx()),
    ).toMatchInlineSnapshot(`
      {
        "_meta": {
          "block": {
            "hash": null,
            "number": 24240020,
            "timestamp": 1768478831,
          },
          "deployment": "envio:1:24240020",
          "hasIndexingErrors": false,
        },
      }
    `);
  });

  it("holds at timestamp 0 on an index with no events, and says so", () => {
    const warnings: string[] = [];
    const out = shapeMeta(
      { progressBlock: 9070, latestEventTimestamp: "0" },
      { ...ctx(), warn: (m) => warnings.push(m) },
    );
    expect((out._meta as { block: { timestamp: number } }).block.timestamp).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});
