/*
 * ProtocolFeeUpdated handler for Uniswap v4 pools.
 *
 * `ProtocolFees.setProtocolFee` emits `ProtocolFeeUpdated(id, protocolFee)` on
 * every change, with the packed uint24 (low 12 bits zeroForOne, high 12 bits
 * oneForZero, hundredths of a bip). A pool is created with protocolFee 0 and
 * `Pool.initialize` emits nothing for it, so Initialize (which seeds 0) plus
 * this event is a complete record of the value.
 *
 * It is stored because the `fee` on a Swap event is the COMBINED LP + protocol
 * fee: swap-handler.ts subtracts the swap's direction's share to book the LP fee.
 * See the note in utils/fees.ts.
 *
 * REPLAY: a plain overwrite, so re-delivering the event is harmless. A replay
 * that rewinds to an earlier ProtocolFeeUpdated and walks forward re-applies
 * every later one on the way back to the head; the swaps it re-delivers in
 * between are skipped by swap-handler.ts's own replay guard, so none of them is
 * priced at the transient value.
 */
import { indexer } from "envio";
import { getChainConfig } from "../utils/chains";

indexer.onEvent(
  { contract: "PoolManager", event: "ProtocolFeeUpdated" },
  async ({ event, context }) => {
    const chainConfig = getChainConfig(event.chainId);
    if (chainConfig.poolsToSkip.includes(event.params.id)) {
      return;
    }

    const pool = await context.Pool.get(`${event.chainId}_${event.params.id}`);
    // No Initialize seen for this pool (a skipped pool, or a range that started
    // after it): there is no row to update, and creating one here would be a
    // pool with no tokens or price.
    if (!pool) {
      return;
    }

    context.Pool.set({
      ...pool,
      protocolFee: BigInt(event.params.protocolFee),
    });
  },
);
