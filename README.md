# Uniswap V4 Indexer

[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-7289da?logo=discord&logoColor=white)](https://discord.com/invite/envio)

A public, open-source multichain Uniswap V4 indexer built with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview). Powers [v4.xyz](https://v4.xyz), the hub for Uniswap V4 data and hooks analytics.

Open to contributions.

![v4.xyz Dashboard](./v4.gif)

## What This Indexes

This indexer tracks all key events from Uniswap V4 `PoolManager` and `PositionManager` contracts across multiple chains:

**Events indexed:**
- `Initialize` - pool creation with fee, tick spacing, and hooks
- `Swap` - all swaps with amounts, price, liquidity, and transaction details
- `ModifyLiquidity` - liquidity additions and removals
- `Donate` - donations to pools
- `Transfer` / `Approval` - ERC-6909 token transfers and approvals

**Chains:**
Ethereum, Optimism, Base, Arbitrum, Polygon, Blast, Zora, Avalanche, BNB Chain, Unichain, World Chain, Soneium, Ink, Linea, Celo

## What's Indexed

The GraphQL API exposes pool statistics, swap history, liquidity positions, and ERC-6909 token data across all supported chains. You can use this to power analytics dashboards, trading interfaces, liquidity trackers, hook monitors, and cross-chain Uniswap V4 data aggregations.


## Prerequisites

- [Node.js](https://nodejs.org/en/download/current) v24 or newer
- [pnpm](https://pnpm.io/installation) v8 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick Start

```bash
# Install dependencies
pnpm i

# Run locally (starts indexer + GraphQL API at http://localhost:8080)
pnpm envio dev
```

The Hasura console is available at [http://localhost:8080](http://localhost:8080) where you can explore and query indexed data using GraphQL.

## Serving the subgraph dialect (`proxy/`)

Envio answers GraphQL through Hasura, whose dialect does not match The Graph's:
`Pool` not `pools`, `where: { volumeUSD: { _gt: "0" } }` not
`where: { volumeUSD_gt: "0" }`, `order_by`/`limit`/`offset` not
`orderBy`/`orderDirection`/`first`/`skip`. None of that is configurable — the
root field name is fixed to the entity name in Envio's Hasura setup, and the
argument grammar is Hasura's own.

`proxy/` is a small service that translates between the two, one process per
chain, so a consumer written against a Uniswap v4 subgraph can point at this
indexer without changing a single query:

```
consumer ──(subgraph dialect)──► proxy ──(Hasura dialect)──► this indexer
```

It also reverses the `<chainId>_` id prefix this indexer adds, and stitches
`Pool.token0`/`token1` — stored here as `String` columns rather than relations —
back into the nested `token0 { id symbol decimals }` shape a subgraph returns.

Run both with one command:

```bash
PROXY_CHAIN_ID=1 ENVIO_CONFIG=config.ethereum.yaml pnpm dev:all
```

`dev:all` supervises the indexer and the proxy together, prefixes their output,
and stops the stack if either dies. It derives `ENVIO_PG_SCHEMA` and
`ENVIO_CLICKHOUSE_DATABASE` from the config filename — `config.ethereum.yaml`
gets the `ethereum` schema, plain `config.yaml` keeps envio's `public` default.
That matters: a single-chain config is a different dataset with a different
`name:`, and sharing storage with the multi-chain one trips envio's
incompatible-config guard. Set either variable explicitly to override. They cannot be a single process: envio
serves GraphQL through Hasura, and its own Express server has fixed routes with
no extension point, so a GraphQL endpoint cannot be mounted inside it.

Or separately, if you want them in different terminals:

```bash
pnpm envio dev --config config.ethereum.yaml

cd proxy && pnpm install
PROXY_CHAIN_ID=1 PROXY_HASURA_URL=http://localhost:8080/v1/graphql pnpm dev
```

See [proxy/README.md](proxy/README.md) for the full translation surface, the
`_meta` shim, and the error policy. It is a separate package with its own deps
and test command; the root `pnpm test` deliberately excludes it.

## Regenerate Files

If you modify `config.yaml` or `schema.graphql`:

```bash
pnpm codegen
```

## RPC Configuration

RPC endpoints for each chain can be customized via environment variables prefixed with `ENVIO_`. See `.env.example` for the full list:

```bash
ENVIO_MAINNET_RPC_URL=https://your-mainnet-node
ENVIO_ARBITRUM_RPC_URL=https://your-arbitrum-node
```

## Querying the Data

Once running, query the GraphQL API to explore pool and swap data:

```graphql
{
  Pool(limit: 10, order_by: {volumeUSD: desc}) {
    id
    token0 { symbol }
    token1 { symbol }
    volumeUSD
    totalValueLockedUSD
  }
}
```

## Built With

- [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) - multichain indexing framework
- [HyperSync](https://docs.envio.dev/docs/HyperSync/overview) - high-performance blockchain data retrieval
- Based on the [Uniswap V4 Subgraph](https://github.com/Uniswap/v4-subgraph) schema (pricing and core entity logic)

## Documentation

- [HyperIndex Docs](https://docs.envio.dev/docs/HyperIndex/overview)
- [Uniswap V4 Multichain Indexer Reference](https://docs.envio.dev/docs/HyperIndex/example-uniswap-v4-multi-chain-indexer)
- [Uniswap V4 Docs](https://docs.uniswap.org/contracts/v4/overview)

## Contributing

This indexer is open to contributions. Open an issue or pull request on [GitHub](https://github.com/enviodev/uniswap-v4-indexer).

## Support

- [Discord community](https://discord.com/invite/envio)
- [Envio Docs](https://docs.envio.dev)
