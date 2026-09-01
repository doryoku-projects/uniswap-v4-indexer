# envio-graph-proxy

Serves **The Graph's query dialect** in front of an **Envio/Hasura** indexer, so a
consumer written against a Uniswap subgraph can point at Envio without changing a
single query.

One process serves one chain — exactly like a subgraph URL does. That is what
makes id translation a pure string transform rather than a lookup.

```
backend ──(subgraph dialect)──► envio-graph-proxy ──(Hasura dialect)──► Envio
```

## Why this exists

Envio serves GraphQL through Hasura, and the dialects do not overlap:

| | The Graph | Hasura |
|---|---|---|
| root field | `pools` | `Pool` |
| filter | `where: { volumeUSD_gt: "0" }` | `where: { volumeUSD: { _gt: "0" } }` |
| sort | `orderBy: date, orderDirection: desc` | `order_by: [{ date: desc }]` |
| page | `first: 100, skip: 200` | `limit: 100, offset: 200` |

None of this is configurable in Envio — `Hasura.res` hardcodes the root field to
the entity name, and the argument grammar is Hasura's own. So the translation has
to live somewhere, and putting it here keeps it out of every consumer.

## Run

```bash
pnpm install
PROXY_CHAIN_ID=4663 PROXY_HASURA_URL=http://localhost:8080/v1/graphql pnpm dev
```

| Env | Default | Meaning |
|---|---|---|
| `PROXY_CHAIN_ID` | *required* | The one chain this process serves |
| `PROXY_HASURA_URL` | *required* | Envio's Hasura GraphQL endpoint |
| `PROXY_HASURA_ADMIN_SECRET` | — | Sent as `x-hasura-admin-secret` |
| `PROXY_PORT` | `4350` | |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `20000` | |

Point a consumer at `http://host:4350/`. `GET /health` returns liveness.

## What it translates

Only the documents the tickwise backend actually issues — `pools`, `pool`,
`tokens`, `token`, `bundles`, `bundle`, `ticks`, `tick`, `poolDayDatas`,
`poolHourDatas`, `tokenDayDatas`, `tokenHourDatas`, `_meta`. Anything else is a
loud error, never a silently-empty result. Adding a root field is one line in
`ROOT_FIELDS` plus its `EntitySpec`.

### Id translation

Envio is multi-chain on one endpoint with no `disable_default_cross_chain`, so
every id carries a `<chainId>_` prefix that a subgraph consumer must never see.

| entity | subgraph | envio |
|---|---|---|
| Pool / Token | `0xabc…` | `1_0xabc…` |
| Tick | `0xabc…#-887220` | `1_0xabc…#-887220` |
| `*DayData` / `*HourData` | `0xabc…-20468` | `1_0xabc…_20468` |
| Bundle | `1` | `<chainId>` |

The transform preserves relative byte ordering, which the historical pricing
provider's `orderBy: id` + `id_gt` cursor walk depends on to terminate. There is
a property test for exactly that.

### Pool.token0 / token1

Envio stores these as `String!` columns holding a complete `Token.id`, not as
relations, so `token0 { id symbol decimals }` cannot be a Hasura join. The proxy
selects the column, batches one `Token(where: {id: {_in: […]}})` per response,
and stitches. A pool referencing a token row that does not exist raises rather
than emitting a half-built object.

### `_meta`

Envio's `_meta` view has **no block timestamp column of any kind**
(`InternalTable.res:647-661`). `block.number` maps to `progressBlock` — not
`sourceBlock` or `bufferBlock`, which run ahead of what is queryable and would
let a caller advance a cursor over a gap. `block.timestamp` is synthesized from
the newest indexed `Swap` / `ModifyLiquidity`. For a cursor ceiling that is
strictly safer than a true block timestamp: it can never advance past data the
indexer actually holds.

## Error policy

The governing rule: **a failed request must never produce a well-formed empty
`data`.** `{ data: { pools: [] } }` is indistinguishable from a healthy
end-of-walk, so an outage would look like a completed sync.

| Condition | HTTP | Why |
|---|---|---|
| Unsupported field / argument / operator | 200 + `errors[]`, no `data` | A translation bug must not look like congestion. `>= 500` would trip the pricing providers' rate-limit circuit-breaker and mask it. |
| Hasura returned `errors[]` | 200, forwarded **verbatim** | Rewording would destroy or fabricate a match against the backend's retry heuristic. |
| Hasura 5xx / unreachable | 502 | A real outage *should* trip the breaker and be retried. |
| Hasura 429 | 429, `Retry-After` copied through | Both pricing providers branch on it. |

Proxy-generated messages are asserted never to match the backend's transient
gateway-retry regex, so a permanent bug fails fast instead of being retried.

## Tests

```bash
pnpm test
```

`translate()` is pure and `postProcess()` takes its only I/O through an injected
`loadTokens`, so the whole translation and reshaping surface is covered with no
Hasura and no network. `test/fixtures.ts` holds the backend's documents copied
byte-exact — a formatting change there that alters the emitted Hasura document
shows up as a failing diff rather than a production surprise.

Not covered offline, and worth a live check before cutover: that the running
indexer's root fields and column names match `schema-map.ts`.

## Limits

- No time-travel (`block: { number: }`). Envio's entity-history tables are not
  tracked in Hasura, so there is nothing to emulate. The backend issues none.
- No `positionTransactions` / `uniswapPositions` / `poolSnapshots` — those are
  Revert-shape entities that do not exist in Envio, and the paths issuing them
  route to Ponder.
- No aggregates. `ENVIO_HASURA_PUBLIC_AGGREGATE` is unset by default upstream.
