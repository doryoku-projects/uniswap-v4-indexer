/*
 * The only module that opens a socket.
 *
 * Status mapping is deliberate — see the error table in README. A translation
 * bug must NOT look like congestion to the backend, and a real outage must.
 */

import { UpstreamTransportError } from "./errors.js";
import type { ProxyConfig } from "./config.js";
import type { Row } from "./postprocess.js";

export interface HasuraResult {
  readonly data?: Record<string, unknown>;
  readonly errors?: unknown[];
}

export class HasuraClient {
  constructor(private readonly cfg: ProxyConfig) {}

  async execute(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<HasuraResult> {
    let res: Response;
    try {
      res = await fetch(this.cfg.hasuraUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.hasuraAdminSecret
            ? { "x-hasura-admin-secret": this.cfg.hasuraAdminSecret }
            : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.cfg.upstreamTimeoutMs),
      });
    } catch (e) {
      throw new UpstreamTransportError(
        `upstream indexer error: ${(e as Error).message}`,
        502,
      );
    }

    if (res.status === 429) {
      throw new UpstreamTransportError(
        "upstream indexer is rate limiting",
        429,
        res.headers.get("retry-after") ?? undefined,
      );
    }
    if (res.status >= 500) {
      throw new UpstreamTransportError(
        `upstream indexer error: HTTP ${res.status}`,
        502,
      );
    }
    if (res.status !== 200) {
      throw new UpstreamTransportError(
        `upstream indexer error: HTTP ${res.status}`,
        502,
      );
    }
    return (await res.json()) as HasuraResult;
  }

  /**
   * Batched Token primary-key lookup backing the Pool.token0/token1 stitch.
   * Chunked because a pools page can reference ~200 distinct tokens and a
   * single `_in` list should stay well under any statement limit.
   */
  async loadTokens(envioIds: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const CHUNK = 500;
    for (let i = 0; i < envioIds.length; i += CHUNK) {
      const slice = envioIds.slice(i, i + CHUNK);
      const r = await this.execute(
        `query ProxyTokens($ids: [String!]!) {
  Token(where: { id: { _in: $ids } }, limit: ${CHUNK}) {
    id chainId symbol name decimals totalSupply volume volumeUSD
    untrackedVolumeUSD feesUSD txCount poolCount totalValueLocked
    totalValueLockedUSD totalValueLockedUSDUntracked derivedETH
  }
}`,
        { ids: slice },
      );
      if (r.errors?.length) {
        throw new UpstreamTransportError(
          `upstream indexer error while loading tokens`,
          502,
        );
      }
      for (const row of (r.data?.Token as Row[] | undefined) ?? []) {
        out.set(String(row.id), row);
      }
    }
    return out;
  }
}
