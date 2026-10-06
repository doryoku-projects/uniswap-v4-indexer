/*
 * The canonical v4 PositionManager per chain.
 *
 * This file also held each chain's StateView and Multicall3 addresses, for the
 * uncollected-fee sweep and the per-event `getFeeGrowthInside` read. Both were
 * removed when uncollected fees moved to the Tickwise backend, so nothing in
 * this indexer calls StateView any more. The verified addresses are in git
 * history if they are ever needed again.
 */

/**
 * The canonical PositionManager per chain, lowercased — the ONLY caller of
 * `PoolManager.modifyLiquidity` whose `salt` is an NFT tokenId.
 *
 * Position ATTRIBUTION needs nothing but this address, and it must work on
 * every chain `config.yaml` indexes — otherwise turning on a chain silently
 * produces no positions.
 *
 * SOURCE, AND THE ONE MAINTENANCE RULE
 *
 * Every value below is the `PositionManager` address of the same chain's block
 * in `config.yaml`, lowercased — the same address the indexer subscribes to for
 * `Transfer`, i.e. already this repo's definition of "the PositionManager" on
 * that chain. Keeping them equal is what guarantees that every NFT whose
 * ownership is tracked also has its liquidity attributed. THEY ARE TWO COPIES:
 * adding or changing a chain in `config.yaml` must change this table in the same
 * edit (`positionGuards.test.ts` fails if they drift).
 */
const POSITION_MANAGERS: Readonly<Record<number, string>> = {
  1: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", // ethereum
  10: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017", // optimism
  56: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b", // bnb chain
  130: "0x4529a01c7a0410167c5740c487a8de60232617bf", // unichain
  137: "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9", // polygon
  143: "0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016", // monad
  480: "0xc585e0f504613b5fbf874f21af14c65260fb41fa", // world chain
  1868: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566", // soneium
  4326: "0x9ae0921e981aaa7308f176f8d4f9129b9247c89d", // (config.yaml labels this one "?")
  4663: "0x58daec3116aae6d93017baaea7749052e8a04fa7", // robinhood chain
  7777777: "0xf66c7b99e2040f0d9b326b3b7c152e9663543d63", // zora
  8453: "0x7c5f5a4bbd8fd63184577525326123b519429bdc", // base
  42161: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869", // arbitrum one
  42220: "0xf7965f3981e4d5bc383bfbcb61501763e9068ca9", // celo
  43114: "0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd", // avalanche
  57073: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566", // ink
  59144: "0xddcad5775b2816a87495f207731b3571d7ee3c76", // linea
  81457: "0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad", // blast
};

/**
 * The PositionManager for a chain (lowercase), or `undefined` when this chain
 * has no entry — in which case NO ModifyLiquidity on it can be attributed to an
 * NFT position, because there is nothing to check `sender` against.
 */
export function positionManagerFor(chainId: number): string | undefined {
  return POSITION_MANAGERS[chainId];
}
