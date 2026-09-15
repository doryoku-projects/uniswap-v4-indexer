/*
 * ORDINAL PAIRING: which `modifyLiquidity` call frame belongs to THIS
 * ModifyLiquidity event.
 *
 * THE DEFECT THIS REPLACES
 *
 * When a PositionManager settles fees, the PoolManager emits TWO
 * ModifyLiquidity events for the SAME salt inside one transaction:
 *
 *     frame 1: liquidityDelta == 0            feesAccrued = ALL THE FEES
 *     frame 2: liquidityDelta == the real +/- feesAccrued = (0, 0)
 *
 * The handler used to pick its frame with `[...fees].reverse().find(salt)` —
 * LAST-wins — which selects the ZERO frame. Measured against chain truth on
 * Avalanche: a zero-fee frame returned in 1,163 of 2,087 cases, and 101/101 of
 * the traced multi-event transactions had the fee on the FIRST frame and exactly
 * zero on the last.
 *
 * FLIPPING TO FIRST-WINS IS NOT THE FIX, and this is the trap. Once the trace
 * gate is widened, BOTH same-salt events trace, so both would resolve to the
 * same first frame and the fee would be counted TWICE. Nor is keying on
 * (salt, tickLower, tickUpper, liquidityDelta) enough: tx 0x44e8625d81
 * (position 43114_7842) has two frames identical in ALL FOUR fields, and 35
 * transactions have two frames identical in salt + ticks + delta.
 *
 * SO THE PAIRING IS ORDINAL. The k-th same-salt LOG is the k-th same-salt call
 * FRAME — verified across all 2,062 Avalanche settlement transactions, matching
 * on (tickLower, tickUpper, liquidityDelta, salt), 2062/2062, zero exceptions.
 * The effect stamps each frame with its per-salt ordinal in execution order
 * (`framesFromTrace`, effects/feesAccrued.ts); the handler derives the same
 * ordinal for its own event with `saltOrdinal` below; the two meet in
 * `pickFeeFrame`.
 *
 * WHY THESE ARE PURE FUNCTIONS IN THEIR OWN MODULE. They decide whether real
 * money is attributed once, twice, or not at all, and neither the handler's
 * 800-line body nor an end-to-end run can assert the invariant that matters —
 * that the fees attributed across the same-salt events of one transaction sum
 * to exactly the fees in that transaction's frames. Here it is one assertion
 * over two pure functions (`feeFramePairing.test.ts`).
 */

import type { ModifyFrame } from "../effects/feesAccrued";

/**
 * The fields of a prior ModifyLiquidity ENTITY row the ordinal is counted over.
 * Structurally a subset of the generated entity type, so the handler passes its
 * rows through unchanged and this module needs no codegen dependency.
 */
export interface PriorModifyRow {
  readonly chainId: bigint;
  readonly salt: string;
  readonly logIndex: bigint;
}

/** Everything identifying THIS event for pairing purposes. */
export interface EventFrameKey {
  readonly chainId: number;
  /** `event.params.salt`, the raw bytes32 — compared case-insensitively. */
  readonly salt: string;
  readonly logIndex: number;
  readonly tickLower: bigint;
  readonly tickUpper: bigint;
  readonly liquidityDelta: bigint;
}

/**
 * Which occurrence THIS event is among the same-salt ModifyLiquidity logs of its
 * transaction — 0 for the first, 1 for the second, and so on.
 *
 * STATELESS BY CONSTRUCTION, WHICH IS THE REQUIREMENT. `rows` is every
 * ModifyLiquidity entity already written for this transaction hash; the answer
 * is the count of them that share this salt and carry a STRICTLY LOWER log
 * index. There is no counter and no accumulator anywhere, which matters for
 * three reasons that a mutable per-(txHash, salt) counter fails:
 *
 *  1. THE TWO PASSES. Envio runs every handler in a batch CONCURRENTLY in the
 *     preload pass and then again STRICTLY SERIALLY in the real pass
 *     (EventProcessing.res.mjs:225,229). A counter shared across the passes
 *     double-counts; one reset between them is a race. This function is called
 *     only on the real path and reads only committed facts, so neither applies.
 *
 *  2. REPLAY. A batch can be re-processed after a rollback. Counting STRICTLY
 *     LOWER log indices is idempotent — the event's own row, rewritten on the
 *     replay, carries its own log index and so can never change its own answer.
 *     It is the same argument, and the same shape, as the gas-bearer rule in
 *     modifyLiquidity-handler.ts.
 *
 *  3. RESTARTS AND BATCH BOUNDARIES. The rows are persisted entities, so an
 *     earlier same-salt event of the same transaction is still counted if it
 *     landed in a previous batch, or before a restart. An in-memory counter
 *     would silently restart at 0 and re-attribute the first frame's fee.
 *
 * The entity is written for EVERY ModifyLiquidity this indexer sees, whatever
 * the caller, which is what makes the count line up with the frame list — the
 * trace's frames are likewise every `modifyLiquidity` call, not only the
 * PositionManager's.
 */
export function saltOrdinal(rows: readonly PriorModifyRow[], key: EventFrameKey): number {
  const salt = key.salt.toLowerCase();
  const chainId = BigInt(key.chainId);
  const logIndex = BigInt(key.logIndex);
  let n = 0;
  for (const r of rows) {
    if (r.chainId === chainId && r.salt.toLowerCase() === salt && r.logIndex < logIndex) n++;
  }
  return n;
}

/*
 * THE ONE ASSUMPTION THIS RESTS ON, recorded because it counts money.
 *
 * The count above is the true ordinal only if every same-salt event with a
 * LOWER logIndex has already been written. Envio 3.7.0 dispatches a
 * transaction's events in ascending logIndex, so it holds. If that ever stops
 * holding the failure is a SILENT DOUBLE COUNT: event B at logIndex L+1
 * processed first sees no prior row and takes ordinal 0 (the fee frame), then
 * event A at L sees B's row, which is not < L, and takes ordinal 0 as well.
 * Reproduced on tx 0x44e8625d81 (position 43114_7842): in log order the pair
 * attributes 6111721, in reverse order 12223442. The tick/delta integrity check
 * in `pickFeeFrame` cannot catch it, because those two frames are identical in
 * salt, ticks AND delta — which is the whole reason the pairing is ordinal.
 *
 * REJECTED FIX, so nobody re-attempts it: refusing to answer when a same-salt
 * row exists at a HIGHER logIndex. That looks like a free safety net and is not
 * — it breaks REPLAY. A re-processed batch still carries the previous run\'s
 * rows, including the higher ones, so the guard would fire on every replay and
 * attribute zero on a real code path, trading a currently-impossible risk for a
 * live one. Counting strictly-lower is what makes replay idempotent (see point
 * 2 above) and that property is worth more than the guard.
 *
 * If envio\'s ordering ever does become a question, the sound fix is to carry
 * each frame\'s own logIndex out of the trace rather than to infer an ordinal.
 */

export type FramePick =
  /** The frame at this ordinal, and it describes this event. Attribute it. */
  | { readonly status: "matched"; readonly frame: ModifyFrame }
  /**
   * No frame at this ordinal. NOT an error and not a warning: an event whose
   * transaction the trace could not be taken for, a salt no frame carries, or
   * simply more same-salt logs than frames. Record zero.
   */
  | { readonly status: "absent" }
  /**
   * A frame exists at this ordinal but does NOT describe this event — its ticks
   * or its liquidity delta disagree. The ordinal is therefore not trustworthy
   * for this transaction, and a wrong frame is somebody else's money. Record
   * zero and say so loudly.
   */
  | { readonly status: "mismatched"; readonly frame: ModifyFrame };

/**
 * THE pairing. Ordinal only — the ticks and the delta are an integrity check,
 * never a search key.
 *
 * Using them to search is what fails on the 35 transactions whose two frames are
 * identical in salt, ticks and delta. Using them to CHECK is free and catches
 * the one way the ordinal can drift: this indexer skips some pools
 * (`chainConfig.poolsToSkip`, and any pool with no row yet), so such a
 * ModifyLiquidity writes no entity and is not counted, while its call frame is
 * still in the trace. When that happens the frame at our ordinal describes a
 * different call, and the check turns a wrong number into a zero and a loud log
 * — under-reporting, which is the direction that cannot invent money.
 */
export function pickFeeFrame(
  frames: readonly ModifyFrame[],
  key: EventFrameKey,
  ordinal: number,
): FramePick {
  const salt = saltToDecimal(key.salt);
  const frame = frames.find((f) => f.salt === salt && f.ordinal === ordinal);
  if (!frame) return { status: "absent" };
  if (
    BigInt(frame.tickLower) !== key.tickLower ||
    BigInt(frame.tickUpper) !== key.tickUpper ||
    frame.liquidityDelta !== key.liquidityDelta
  ) {
    return { status: "mismatched", frame };
  }
  return { status: "matched", frame };
}

/**
 * The salt as the trace reports it: `BigInt(bytes32).toString()`, i.e. the
 * decimal tokenId. Both sides must normalise identically or nothing pairs.
 */
export function saltToDecimal(salt: string): string {
  return BigInt(salt).toString();
}
