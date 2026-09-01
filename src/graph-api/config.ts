/*
 * One server serves ONE chain, exactly as a subgraph endpoint does. That is what
 * makes id translation a pure string transform rather than a lookup.
 *
 * Connection settings mirror envio's own ENVIO_PG_* variables and defaults
 * (Env.res:105-130) so this reads the same database the indexer writes.
 */

import { InternalError } from "./errors.js";

export interface GraphApiConfig {
  readonly chainId: number;
  readonly schema: string;
  readonly port: number;
  readonly pg: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
    readonly max: number;
  };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GraphApiConfig | null {
  // Absent chain id means "not configured" — the server simply does not start,
  // which is the right default for an indexer that nobody queries this way.
  const raw = env.GRAPH_API_CHAIN_ID;
  if (!raw) return null;

  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new InternalError(`GRAPH_API_CHAIN_ID must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  const schema = env.ENVIO_PG_SCHEMA ?? "public";
  if (!IDENT.test(schema)) {
    throw new InternalError(`ENVIO_PG_SCHEMA ${JSON.stringify(schema)} is not a plain identifier`);
  }

  return {
    chainId,
    schema,
    port: Number(env.GRAPH_API_PORT ?? 4350),
    pg: {
      host: env.ENVIO_PG_HOST ?? "localhost",
      port: Number(env.ENVIO_PG_PORT ?? 5433),
      user: env.ENVIO_PG_USER ?? "postgres",
      password: env.ENVIO_PG_PASSWORD ?? "testing",
      database: env.ENVIO_PG_DATABASE ?? "envio-dev",
      // Its own small pool: envio's ENVIO_PG_MAX_CONNECTIONS defaults to 2 and
      // is sized for the writer, so borrowing from it would starve indexing.
      max: Number(env.GRAPH_API_PG_MAX ?? 4),
    },
  };
}
