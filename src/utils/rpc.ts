/*
 * RPC endpoint per chain, for the code paths that must talk to a node directly.
 *
 * Extracted from `tokenMetadata.ts`, where it was private, so that every effect
 * resolves its endpoint the same way. Two of them now need it: the token
 * metadata reads that were always here, and the position fee reads
 * (`getFeeGrowthInside` / `getPositionInfo` and `debug_traceTransaction`) ported
 * from Ponder.
 *
 * Note the fee paths have stricter requirements than metadata does. The traces
 * need an ARCHIVE node with the `debug` namespace, and a public fallback will
 * not serve them — a chain whose var is unset degrades to zero collected fees
 * rather than failing, which is deliberate but worth knowing when a chain's
 * numbers look low.
 */

export const getRpcUrl = (chainId: number): string => {
  switch (chainId) {
    case 1:
      return process.env.ENVIO_MAINNET_RPC_URL || "https://eth.drpc.org";
    case 42161:
      return process.env.ENVIO_ARBITRUM_RPC_URL || "https://arbitrum.drpc.org";
    case 10:
      return process.env.ENVIO_OPTIMISM_RPC_URL || "https://optimism.drpc.org";
    case 8453:
      return process.env.ENVIO_BASE_RPC_URL || "https://base.drpc.org";
    case 137:
      return process.env.ENVIO_POLYGON_RPC_URL || "https://polygon.drpc.org";
    case 43114:
      return (
        process.env.ENVIO_AVALANCHE_RPC_URL || "https://avalanche.drpc.org"
      );
    case 56:
      return process.env.ENVIO_BSC_RPC_URL || "https://bsc.drpc.org";
    case 81457:
      return process.env.ENVIO_BLAST_RPC_URL || "https://blast.drpc.org";
    case 7777777:
      return process.env.ENVIO_ZORA_RPC_URL || "https://zora.drpc.org";
    case 1868:
      return process.env.ENVIO_SONIEUM_RPC_URL || "https://sonieum.drpc.org";
    case 130:
      return process.env.ENVIO_UNICHAIN_RPC_URL || "https://unichain.drpc.org";
    case 57073:
      return process.env.ENVIO_INK_RPC_URL || "https://ink.drpc.org";
    case 480:
      return (
        process.env.ENVIO_WORLDCHAIN_RPC_URL || "https://worldchain.drpc.org"
      );
    case 143:
      return process.env.ENVIO_MONAD_RPC_URL || "https://monad.drpc.org";
    case 59144:
      return process.env.ENVIO_LINEA_RPC_URL || "https://linea.drpc.org";
    case 42220:
      return process.env.ENVIO_CELO_RPC_URL || "https://celo.drpc.org";
    case 4326:
      return process.env.ENVIO_MEGAETH_RPC_URL || "https://megaeth.drpc.org";
    case 4663:
      return (
        process.env.ENVIO_ROBINHOOD_RPC_URL ||
        "https://rpc.mainnet.chain.robinhood.com"
      );
    // Add generic fallback for any chain
    default:
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
};

/**
 * The env var each chain's endpoint comes from, so a failure can name the thing
 * to set. Kept beside `getRpcUrl` rather than derived from it — the switch above
 * is the source of truth for the URL, this is the source of truth for the fix.
 */
const RPC_ENV_VAR: Readonly<Record<number, string>> = {
  1: "ENVIO_MAINNET_RPC_URL",
  10: "ENVIO_OPTIMISM_RPC_URL",
  56: "ENVIO_BSC_RPC_URL",
  130: "ENVIO_UNICHAIN_RPC_URL",
  137: "ENVIO_POLYGON_RPC_URL",
  143: "ENVIO_MONAD_RPC_URL",
  480: "ENVIO_WORLDCHAIN_RPC_URL",
  1868: "ENVIO_SONIEUM_RPC_URL",
  4326: "ENVIO_MEGAETH_RPC_URL",
  4663: "ENVIO_ROBINHOOD_RPC_URL",
  8453: "ENVIO_BASE_RPC_URL",
  42161: "ENVIO_ARBITRUM_RPC_URL",
  42220: "ENVIO_CELO_RPC_URL",
  43114: "ENVIO_AVALANCHE_RPC_URL",
  57073: "ENVIO_INK_RPC_URL",
  59144: "ENVIO_LINEA_RPC_URL",
  81457: "ENVIO_BLAST_RPC_URL",
  7777777: "ENVIO_ZORA_RPC_URL",
};

/** Chains whose var is unset or empty, i.e. running on the public fallback. */
export function chainsOnPublicFallback(chainIds: Iterable<number>): number[] {
  const out: number[] = [];
  for (const id of chainIds) {
    const envVar = RPC_ENV_VAR[id];
    if (!envVar) continue; // no known var: getRpcUrl will throw on its own
    if (!process.env[envVar]?.trim()) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/**
 * STARTUP GATE: refuse to index a chain that has no configured RPC.
 *
 * WHY THIS IS A HARD FAILURE AND NOT A WARNING.
 *
 * `getRpcUrl` falls back to a public drpc.org endpoint, and the note at the top
 * of this file spells out the consequence: a public endpoint will not serve
 * `debug_traceTransaction`, so "a chain whose var is unset degrades to zero
 * collected fees rather than failing". Exact collected fees are the entire
 * reason this indexer exists, so that degradation is not a lesser outcome — it
 * is the indexer quietly producing wrong numbers.
 *
 * And it is invisible. The chain still syncs from HyperSync, the progress
 * reaches 100%, no handler throws, and the dashboard is green. The only symptom
 * is that fee columns read 0, which is indistinguishable from a position that
 * genuinely earned nothing. A warning in a cloud log is exactly what gets
 * missed; refusing to start is not.
 *
 * Measured reason to gate this rather than trust review: with `config.yaml` as
 * it ships (chains 1, 10, 8453, 42161, 43114, 4663) and `.env` as it is, only
 * 43114 has a real endpoint. Five of six chains would silently report zero
 * collected fees.
 *
 * `ENVIO_ALLOW_PUBLIC_RPC=true` opts out, for a smoke test where fee accuracy
 * is not the point. It warns per chain instead, so the degradation is at least
 * on the record.
 */
export function assertRpcUrlsConfigured(
  chainIds: Iterable<number>,
  log?: { warn: (msg: string) => void }
): void {
  const missing = chainsOnPublicFallback(chainIds);
  if (missing.length === 0) return;

  const detail = missing.map((id) => `  chain ${id}: set ${RPC_ENV_VAR[id]}`).join("\n");

  if (process.env.ENVIO_ALLOW_PUBLIC_RPC?.trim() === "true") {
    const warn = log?.warn ?? ((m: string) => console.warn(m));
    for (const id of missing) {
      warn(
        `chain ${id} has no ${RPC_ENV_VAR[id]} and is using a PUBLIC RPC. ` +
          `debug_traceTransaction is not available there, so collected fees ` +
          `for this chain will be recorded as 0. Allowed by ` +
          `ENVIO_ALLOW_PUBLIC_RPC=true.`
      );
    }
    return;
  }

  throw new Error(
    `No RPC endpoint configured for ${missing.length} indexed chain(s):\n${detail}\n\n` +
      `These chains would fall back to a public endpoint that cannot serve\n` +
      `debug_traceTransaction, and would silently record ZERO collected fees\n` +
      `while appearing fully synced.\n\n` +
      `Fix one of:\n` +
      `  - set the vars above to archive endpoints with the debug namespace\n` +
      `  - comment those chains out of your config\n` +
      `  - set ENVIO_ALLOW_PUBLIC_RPC=true to accept zero fees on them`
  );
}
