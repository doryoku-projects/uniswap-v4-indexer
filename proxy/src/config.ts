/*
 * One proxy process serves ONE chain, exactly like a subgraph URL does. That
 * is what makes id translation a pure string transform instead of a lookup.
 */

export interface ProxyConfig {
  readonly chainId: number;
  readonly hasuraUrl: string;
  readonly hasuraAdminSecret: string | undefined;
  readonly port: number;
  readonly upstreamTimeoutMs: number;
  readonly tokenCacheMax: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`envio-graph-proxy: ${key} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const chainId = Number(required(env, "PROXY_CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`envio-graph-proxy: PROXY_CHAIN_ID must be a positive integer`);
  }
  const hasuraUrl = required(env, "PROXY_HASURA_URL");
  return {
    chainId,
    hasuraUrl,
    hasuraAdminSecret: env.PROXY_HASURA_ADMIN_SECRET,
    port: Number(env.PROXY_PORT ?? 4350),
    upstreamTimeoutMs: Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? 20_000),
    tokenCacheMax: Number(env.PROXY_TOKEN_CACHE_MAX ?? 50_000),
  };
}
