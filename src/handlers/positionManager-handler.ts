/*
 * PositionManager event handlers (Transfer, Subscription, Unsubscription)
 *
 * Mirrors the v4-subgraph's transfer.ts / subscribe.ts / unsubscribe.ts:
 * Position tracks the current owner per tokenId, while Transfer / Subscribe /
 * Unsubscribe are immutable per-event records.
 */
import { indexer } from "envio";
import { positionDefaults } from "./position-fees";

// Positions are per-chain: PositionManager tokenIds collide across chains
const positionId = (chainId: number, tokenId: bigint) =>
  `${chainId}_${tokenId}`;

const eventId = (event: {
  chainId: number;
  block: { number: number };
  logIndex: number;
}) => `${event.chainId}_${event.block.number}_${event.logIndex}`;

indexer.onEvent(
  { contract: "PositionManager", event: "Transfer" },
  async ({ event, context }) => {
    const id = positionId(event.chainId, event.params.id);

    // Mint (from == zero address) creates the position; later transfers only
    // change ownership.
    //
    // The liquidity and fee columns get their zero defaults here because this
    // handler may run before the matching PoolManager.ModifyLiquidity (event
    // order within a mint tx is not guaranteed). The ModifyLiquidity path fills
    // them in and never reads them back from this row, so whichever runs first
    // is safe. The spread below preserves whatever the other path already wrote.
    const position = (await context.Position.get(id)) ?? {
      id,
      chainId: BigInt(event.chainId),
      tokenId: event.params.id,
      owner: event.params.to,
      origin: event.transaction.from || "NONE",
      createdAtTimestamp: BigInt(event.block.timestamp),
      ...positionDefaults(),
      createdAtBlockNumber: BigInt(event.block.number),
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTimestamp: BigInt(event.block.timestamp),
    };

    context.Position.set({ ...position, owner: event.params.to });

    context.Transfer.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.id,
      from: event.params.from,
      to: event.params.to,
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from || "NONE",
      position_id: id,
    });
  }
);

indexer.onEvent(
  { contract: "PositionManager", event: "Subscription" },
  async ({ event, context }) => {
    context.Subscribe.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.tokenId,
      address: event.params.subscriber,
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from || "NONE",
      position_id: positionId(event.chainId, event.params.tokenId),
    });
  }
);

indexer.onEvent(
  { contract: "PositionManager", event: "Unsubscription" },
  async ({ event, context }) => {
    context.Unsubscribe.set({
      id: eventId(event),
      chainId: BigInt(event.chainId),
      tokenId: event.params.tokenId,
      address: event.params.subscriber,
      transaction: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      origin: event.transaction.from || "NONE",
      position_id: positionId(event.chainId, event.params.tokenId),
    });
  }
);
