/*
 * Per-chain addresses and RPC wiring for position fee tracking.
 *
 * Kept OUT of `chains.ts` on purpose: `CHAIN_CONFIGS` there is typed
 * `{ [chainId in EvmChainId]: ChainConfig }`, so every field must be filled for
 * all 18 configured chains. StateView is only verified for the five chains the
 * Ponder indexer actually runs, and inventing addresses for the rest would be
 * worse than having none — a wrong lens address returns plausible garbage.
 *
 * A chain with no StateView entry simply gets no fee tracking: collected and
 * uncollected fees stay 0 and `isPriceable` still applies. Add a chain here
 * only after verifying the address on-chain.
 */

/**
 * PositionManager per chain — the `sender` on a ModifyLiquidity that belongs to
 * an NFT position, and the `owner` argument to getPositionInfo. Mirrors the
 * addresses in config.yaml. Lowercased for comparison.
 */
export const POSITION_MANAGER_BY_CHAIN: Record<number, string> = {
  1: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
  10: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017",
  56: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
  130: "0x4529a01c7a0410167c5740c487a8de60232617bf",
  137: "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9",
  143: "0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016",
  480: "0xc585e0f504613b5fbf874f21af14c65260fb41fa",
  1868: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566",
  4326: "0x9ae0921e981aaa7308f176f8d4f9129b9247c89d",
  4663: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  8453: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
  42161: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
  42220: "0xf7965f3981e4d5bc383bfbcb61501763e9068ca9",
  43114: "0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd",
  57073: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566",
  59144: "0xddcad5775b2816a87495f207731b3571d7ee3c76",
  81457: "0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad",
  7777777: "0xf66c7b99e2040f0d9b326b3b7c152e9663543d63",
};

/**
 * StateView (v4-periphery lens) per chain. ONLY the addresses verified in the
 * Ponder indexer's networks.json — each cross-checked there against
 * `StateView.poolManager()` linking back to the chain's PoolManager.
 */
export const STATE_VIEW_BY_CHAIN: Record<number, string> = {
  1: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  10: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
  4663: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  42161: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  43114: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
};

/**
 * Env var holding an ARCHIVE RPC url per chain. Names follow the existing
 * `ENVIO_<CHAIN>_RPC_URL` convention in .env.example.
 *
 * Archive matters: collected fees are read at the block of each historical
 * ModifyLiquidity, so the endpoint must serve `eth_call` at old blocks. It does
 * NOT need the debug or trace namespace — that is the point of this approach.
 */
export const RPC_ENV_BY_CHAIN: Record<number, string> = {
  1: "ENVIO_MAINNET_RPC_URL",
  10: "ENVIO_OPTIMISM_RPC_URL",
  56: "ENVIO_BSC_RPC_URL",
  130: "ENVIO_UNICHAIN_RPC_URL",
  137: "ENVIO_POLYGON_RPC_URL",
  4663: "ENVIO_ROBINHOOD_RPC_URL",
  8453: "ENVIO_BASE_RPC_URL",
  42161: "ENVIO_ARBITRUM_RPC_URL",
  43114: "ENVIO_AVALANCHE_RPC_URL",
  57073: "ENVIO_INK_RPC_URL",
  81457: "ENVIO_BLAST_RPC_URL",
  7777777: "ENVIO_ZORA_RPC_URL",
};

/** Resolved RPC url for a chain, or undefined when unset. */
export function rpcUrlFor(chainId: number): string | undefined {
  const key = RPC_ENV_BY_CHAIN[chainId];
  if (!key) return undefined;
  const url = process.env[key];
  return url && url.length > 0 ? url : undefined;
}

/**
 * True when this chain can do fee tracking: a verified StateView address AND a
 * configured RPC. Checked once per handler call so a chain without either
 * degrades to zero fees instead of throwing.
 */
export function feeTrackingEnabled(chainId: number): boolean {
  return Boolean(STATE_VIEW_BY_CHAIN[chainId]) && Boolean(rpcUrlFor(chainId));
}
