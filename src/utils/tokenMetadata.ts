import { createPublicClient, http, getContract, type PublicClient } from "viem";
import { ADDRESS_ZERO } from "./constants";
import { getChainConfig } from "./chains";
import { getRpcUrl } from "./rpc";
import { createEffect, S, type Address, type EvmChainId } from "envio";

/*
 * The bytes32 variant of `name()` / `symbol()`, as a SEPARATE ABI.
 *
 * Tokens minted before the ERC-20 string convention settled return `bytes32`
 * from the SAME selectors — `name()` 0x06fdde03 and `symbol()` 0x95d89b41. MKR
 * (0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2) is the canonical example and is
 * in mainnet's `whitelistTokens`.
 *
 * WHY A SECOND ABI RATHER THAN TWO ENTRIES IN ONE. This previously declared the
 * fallback as `name: "NAME"` / `name: "SYMBOL"` inside `ERC20_ABI`, and viem
 * derives the selector from that STRING — so it called `NAME()` (0xa3f4df7e)
 * and `SYMBOL()` (0xf76f8d78), which no token implements. Both reverted, so the
 * fallback never fired for ANY token and MKR indexed as `unknown`/`UNKNOWN`.
 * Two entries with the same name and different outputs cannot coexist in one
 * viem ABI, hence the split.
 */
export const ERC20_BYTES32_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
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
   * Did the CONTRACT answer for `decimals`, or is the 18 below a guess?
   *
   * Mirrors Ponder's `decimalsResolved` (core/token-meta.ts). `true` means a
   * value came back, or came back unusable and 18 is the canonical default —
   * either way the answer is deterministic and safe to cache forever. `false`
   * means the TRANSPORT never answered, so 18 is a guess and the row must not
   * be cached.
   *
   * The asymmetry this exists to capture: a fallback name or symbol is
   * cosmetic, but a fallback `decimals` is quantitatively wrong and silently
   * rescales real money by 10^(18 - real) — a factor of 10^12 for a 6-decimal
   * token like USDC.
   *
   * Adding it as a REQUIRED field also invalidates every row already cached
   * without it: such a row now fails `S.parseOrThrow` on load, is counted as an
   * invalidation, and re-runs. That covers both the Postgres effect cache and
   * the git-tracked `.envio/cache/getTokenMetadata.tsv`, which would otherwise
   * re-import the stale values on the next clean initialize.
   */
  decimalsResolved: S.boolean,
});
type TokenMetadata = S.Output<typeof TokenMetadata>;


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

/**
 * `blockNumber` IS PART OF THE CACHE KEY, on purpose.
 *
 * The reads are pinned to a block (see `fetchTokenMetadataMulticall`), so the
 * block has to be in the key — caching on `(address, chainId)` alone would let
 * one run's answer at one block be served for a different block, which is the
 * same non-determinism the pinning exists to remove.
 *
 * THE COST, MEASURED rather than assumed. An earlier version of this note
 * claimed "one key per token either way", on the reasoning that a Token row is
 * created once so the effect fires once. That is wrong, and the data says so:
 * over blocks 56,195,376-60,970,065 the cache holds 169 rows for 122 tokens —
 * 102 tokens with one entry, 14 with two, two with three, two with four, USDC
 * with nine and native AVAX with sixteen.
 *
 * The mechanism is Envio's batch semantics, not this key. Within one processing
 * batch `context.Token.get` returns undefined for every `Initialize` in it,
 * because the row has not committed yet, so the effect fires once per distinct
 * init block in that batch; after the row commits it never fires again. Each
 * multi-entry token's cached blocks are therefore a contiguous PREFIX of its
 * pool-init blocks, which is exactly the shape observed.
 *
 * So the extra keys are a batch artifact that the block simply makes visible —
 * it is nowhere near per-token-per-pool, which here would be 432. The overhead
 * is 47 redundant RPC triples for the whole range, and every duplicate agrees
 * with every other and with the contract at its own block. Worth knowing before
 * anyone reads a row count as a token count.
 */
export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: S.tuple((t) => ({
      address: t.item(0, S.address),
      chainId: t.item(1, S.number as S.Schema<EvmChainId>),
      blockNumber: t.item(2, S.bigint),
    })),
    output: TokenMetadata,
    rateLimit: false,
    cache: true,
  },
  async ({ context, input: { address, chainId, blockNumber } }) => {
    // Handle native token
    if (address.toLowerCase() === ADDRESS_ZERO.toLowerCase()) {
      const chainConfig = getChainConfig(chainId);
      return {
        name: chainConfig.nativeTokenDetails.name,
        symbol: chainConfig.nativeTokenDetails.symbol,
        decimals: Number(chainConfig.nativeTokenDetails.decimals),
        // From config, not an RPC read: there is nothing to retry.
        decimalsResolved: true,
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
        // From config, not an RPC read: there is nothing to retry.
        decimalsResolved: true,
      };
    }

    try {
      // Use the multicall implementation for efficiency
      return await fetchTokenMetadataMulticall(address, chainId, context, blockNumber);
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

/**
 * Exported ONLY as a test seam. `createEffect` returns an opaque `Effect<I, O>`
 * handle (envio/index.d.ts) with no way to invoke its handler, so the caching
 * gate below — the one rule that keeps a substituted 18 out of the persisted
 * effect cache — is unreachable from a test through `getTokenMetadata`.
 * The effect above remains the only production caller.
 */
export async function fetchTokenMetadataMulticall(
  address: Address,
  chainId: number,
  context: { cache: boolean; log: { warn: (msg: string) => void } },
  blockNumber: bigint
): Promise<TokenMetadata> {
  const client = getClient(chainId);
  const contract = getContract({
    address,
    abi: ERC20_ABI,
    client,
  });
  // Same selectors, bytes32 return — see ERC20_BYTES32_ABI.
  const bytes32Contract = getContract({
    address,
    abi: ERC20_BYTES32_ABI,
    client,
  });

  /*
   * PINNED TO `blockNumber`, not read at the chain head.
   *
   * These calls used to pass no block, so viem resolved them against `latest` —
   * whatever the chain looked like at the moment the indexer happened to reach
   * this token, which for a backfill is millions of blocks after the event being
   * indexed. The values are then not a function of the indexed range at all, and
   * two runs over the same blocks can disagree.
   *
   * Measured on Avalanche: `0xa25eaf2906fa1a3a13edac9b9657108af7b703e3` was
   * stored as `stAVAX` / "Hypha Staked AVAX", while the contract returned
   * `ggAVAX` / "GoGoPool Liquid Staking Token" at the start block, mid-range and
   * at the boundary. The stored values are what it answers only at `latest`. It
   * leaked into `Pool.name` for two pools.
   *
   * `decimals` travels the same path, and that one is not cosmetic: it is a
   * divisor. A proxy that changed decimals between the indexed block and head
   * would mis-scale every historical amount derived from that token, silently
   * and by a power of ten. Worth being precise about the evidence, though:
   * across all 122 tokens in that range, NOT ONE returned a different
   * `decimals()` at its indexed block than at head. The exposure is real; it has
   * not fired here. Do not cite `decimals` as what this fix repaired.
   *
   * WHAT THIS DOES NOT BUY. One read per token, at first sight, makes the answer
   * DETERMINISTIC — not true for all time. `0xcc0966d8418d412c599a6421b760a847eb169a8c`
   * is read at block 58,424,753 as `SolvBTC.BBN`, and renames to `xSolvBTC` at
   * 59,889,338 — inside the indexed range — so the stored symbol is stale for
   * that range's last 1.08M blocks, and there is no second `Initialize` to pick
   * the new one up. Before the fix, the `latest` read happened to match that
   * later state by luck. Tracking a rename properly needs re-reading metadata on
   * some cadence, which is a different feature; what is fixed here is that two
   * runs over the same blocks now agree.
   *
   * The block also belongs in the effect's cache key for the same reason — see
   * the note on `getTokenMetadata` below.
   */
  const at = { blockNumber } as const;

  // Use `null` for failed reads so we can distinguish "read failed" from
  // "read succeeded with a valid empty/zero value".
  const namePromise = contract.read.name(at).catch(() => null);
  const nameBytes32Promise = bytes32Contract.read.name(at).catch(() => null);
  const symbolPromise = contract.read.symbol(at).catch(() => null);
  const symbolBytes32Promise = bytes32Contract.read.symbol(at).catch(() => null);
  const decimalsPromise = contract.read.decimals(at).catch(() => null);

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

  /*
   * A DECIMALS failure alone must prevent caching. This gate used to be a
   * three-way AND, so a transient failure of `decimals()` with `name()` and
   * `symbol()` succeeding WAS cached — with 18 substituted at the return below.
   * Envio's effect cache is persisted and keyed on the input, so that 18
   * survived restarts and a full resync, and every amount derived from the
   * token was mis-scaled by 10^(18 - real) from then on.
   *
   * `name`/`symbol` keep the old, looser rule on purpose: a token may genuinely
   * implement neither, their fallbacks are cosmetic, and re-reading them on
   * every sync is the cost the AND was originally trying to avoid.
   */
  const decimalsResolved = !decimalsFailed;
  if (decimalsFailed) {
    context.cache = false;
    context.log.warn(
      `decimals() did not resolve for ${address} on chain ${chainId}; not caching the 18 fallback`
    );
  } else if (nameFailed && symbolFailed) {
    // Every read that could fail did, which points at the transport rather than
    // a token implementing none of the methods.
    context.cache = false;
    context.log.warn(
      `All ERC-20 reads failed for ${address} on chain ${chainId}; not caching fallback metadata`
    );
  }

  return {
    name: name || "unknown",
    symbol: symbol || "UNKNOWN",
    decimals:
      typeof decimalsResult === "number" &&
      // There's a token on base with decimals ~= 9132491757359273498234t629765928734n
      // which literally crashes our indexer. To prevent it from happening
      // use 18 for all tokens with decimals > 50
      // This is the biggest decimals we've seen so far for other tokens.
      decimalsResult <= 50
        ? decimalsResult
        : 18,
      decimalsResolved,
};
}
