import { createPublicClient, http, getContract, type PublicClient } from "viem";
import { ADDRESS_ZERO } from "./constants";
import { getChainConfig } from "./chains";
import { createEffect, S, type Address, type EvmChainId } from "envio";

const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "NAME",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "SYMBOL",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const TokenMetadata = S.schema({
  name: S.string,
  symbol: S.string,
  decimals: S.number,
  /**
   * false ⇒ `decimals` is the 18 FALLBACK, not an on-chain read.
   *
   * This distinction is load-bearing. `decimals` scales every token amount, so
   * a wrong value corrupts amounts and fees by a power of ten while looking
   * entirely plausible. Measured against the reference Ponder indexer:
   * eUSDt-3 (0xa446938b…3e9e) is 6 decimals on-chain, was stored as 18, and
   * every fee on its positions came out 1e12 too small. `name` and `symbol`
   * being wrong is cosmetic by comparison.
   */
  decimalsResolved: S.boolean,
});
type TokenMetadata = S.Output<typeof TokenMetadata>;

const getRpcUrl = (chainId: number): string => {
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

// Cache of clients per chainId
const clients: Record<number, PublicClient> = {};

// Get client for a specific chain
const getClient = (chainId: number): PublicClient => {
  if (!clients[chainId]) {
    try {
      // Create a simpler client configuration
      clients[chainId] = createPublicClient({
        batch: {
          multicall: true,
        },
        transport: http(getRpcUrl(chainId), {
          batch: true,
        }),
      });
      console.log(`Created client for chain ${chainId}`);
    } catch (e) {
      console.error(`Error creating client for chain ${chainId}:`, e);
      throw e;
    }
  }
  return clients[chainId];
};

// Add this function to sanitize strings by removing null bytes and other problematic characters
function sanitizeString(str: string): string {
  if (!str) return "";

  // Remove null bytes and other control characters that might cause issues with PostgreSQL
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: S.tuple((t) => ({
      address: t.item(0, S.address),
      chainId: t.item(1, S.number as S.Schema<EvmChainId>),
    })),
    output: TokenMetadata,
    // One multicall per token, but it shares the RPC's per-second budget with
    // the position-fee effects in src/utils/stateView.ts — keep the three in
    // sync when changing plan.
    rateLimit: { calls: 4, per: "second" },
    cache: true,
  },
  async ({ context, input: { address, chainId } }) => {
    // Handle native token
    if (address.toLowerCase() === ADDRESS_ZERO.toLowerCase()) {
      const chainConfig = getChainConfig(chainId);
      return {
        name: chainConfig.nativeTokenDetails.name,
        symbol: chainConfig.nativeTokenDetails.symbol,
        decimals: Number(chainConfig.nativeTokenDetails.decimals),
        decimalsResolved: true, // from chain config, not a fallback
      };
    }

    // Check for token overrides in chain config
    const chainConfig = getChainConfig(chainId);
    const tokenOverride = chainConfig.tokenOverrides.find(
      (t) => t.address.toLowerCase() === address.toLowerCase()
    );

    if (tokenOverride) {
      return {
        name: tokenOverride.name,
        symbol: tokenOverride.symbol,
        decimals: Number(tokenOverride.decimals),
        decimalsResolved: true, // explicitly configured
      };
    }

    try {
      // Use the multicall implementation for efficiency
      return await fetchTokenMetadataMulticall(address, chainId, context);
    } catch (e) {
      context.log.error(
        `Error fetching metadata for ${address} on chain ${chainId}:`,
        e as Error
      );
      // Don't persist failed lookups so a future sync can retry.
      context.cache = false;
      throw e;
    }
  }
);

async function fetchTokenMetadataMulticall(
  address: Address,
  chainId: number,
  context: { cache: boolean; log: { warn: (msg: string) => void } }
): Promise<TokenMetadata> {
  const client = getClient(chainId);
  const contract = getContract({
    address,
    abi: ERC20_ABI,
    client,
  });

  // Use `null` for failed reads so we can distinguish "read failed" from
  // "read succeeded with a valid empty/zero value".
  const namePromise = contract.read.name().catch(() => null);
  const nameBytes32Promise = contract.read.NAME().catch(() => null);
  const symbolPromise = contract.read.symbol().catch(() => null);
  const symbolBytes32Promise = contract.read.SYMBOL().catch(() => null);
  const decimalsPromise = contract.read.decimals().catch(() => null);

  const [
    nameResult,
    nameBytes32Result,
    symbolResult,
    symbolBytes32Result,
    decimalsResult,
  ] = await Promise.all([
    namePromise,
    nameBytes32Promise,
    symbolPromise,
    symbolBytes32Promise,
    decimalsPromise,
  ]);

  const nameFailed = nameResult === null && nameBytes32Result === null;
  const symbolFailed = symbolResult === null && symbolBytes32Result === null;
  const decimalsFailed = decimalsResult === null;

  let name = "unknown";
  if (nameResult !== null) {
    name = sanitizeString(nameResult);
  } else if (nameBytes32Result !== null) {
    name = sanitizeString(
      new TextDecoder().decode(
        new Uint8Array(
          Buffer.from(nameBytes32Result.slice(2), "hex").filter((n) => n !== 0)
        )
      )
    );
  }

  let symbol = "UNKNOWN";
  if (symbolResult !== null) {
    symbol = sanitizeString(symbolResult);
  } else if (symbolBytes32Result !== null) {
    symbol = sanitizeString(
      new TextDecoder().decode(
        new Uint8Array(
          Buffer.from(symbolBytes32Result.slice(2), "hex").filter(
            (n) => n !== 0
          )
        )
      )
    );
  }

  const { decimals: resolvedDecimals, decimalsResolved: decimalsInRange } =
    resolveDecimals(decimalsResult);

  // Do NOT persist an unresolved decimals. Previously the cache was only
  // skipped when name AND symbol AND decimals all failed, so a lone decimals
  // failure froze the 18 fallback forever — there is no other correction path,
  // and `cache: true` means it is never retried. That is exactly how eUSDt-3
  // ended up at 18 instead of 6, scaling every fee on its positions by 1e12.
  // Decimals alone is enough to refuse the cache; name/symbol are cosmetic.
  if (!decimalsInRange) {
    context.cache = false;
    context.log.warn(
      `decimals() unresolved for ${address} on chain ${chainId} ` +
        `(raw=${String(decimalsResult)}); using the 18 fallback and NOT caching, ` +
        `so the next sync retries. Amounts for this token are unreliable until then.`
    );
  } else if (nameFailed && symbolFailed) {
    context.log.warn(
      `name() and symbol() both failed for ${address} on chain ${chainId}; decimals is good so amounts are safe`
    );
  }

  return {
    name: name || "unknown",
    symbol: symbol || "UNKNOWN",
    decimals: resolvedDecimals,
    decimalsResolved: decimalsInRange,
  };
}

/**
 * Decide whether an ERC-20 `decimals()` read may be trusted.
 *
 * Exported and pure so the rule is testable, because getting it wrong is
 * expensive and silent: `decimals` scales every token amount, so a fallback
 * masquerading as a real read shifts fees and balances by a power of ten while
 * looking completely normal.
 *
 * Only an in-range numeric read counts as resolved:
 *   - null  -> the call failed (commonly a transient rate limit). Fallback.
 *   - > 50  -> a real token on Base reports ~9.1e33 decimals and crashes the
 *              indexer, so it is clamped. Still a fallback, not truth.
 */
export function resolveDecimals(decimalsResult: number | null | undefined): {
  decimals: number;
  decimalsResolved: boolean;
} {
  const ok = typeof decimalsResult === "number" && Number.isFinite(decimalsResult) &&
    decimalsResult >= 0 && decimalsResult <= 50;
  return { decimals: ok ? decimalsResult : 18, decimalsResolved: ok };
}
