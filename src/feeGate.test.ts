/**
 * Unit tests for the two ModifyLiquidity fee gates (`src/utils/feeGate.ts`).
 *
 * Same rationale as positionGuards.test.ts: each of these exists to prevent a
 * specific PLAUSIBLE WRONG NUMBER — a zero that looks like data. A snapshot
 * test cannot fail on a fee that was never measured; it records the zero.
 *
 * `shouldTraceFees` is the gate on `debug_traceTransaction`, which is the only
 * source of the exact collected fee. `feeGate` decides whether an event is
 * attributable to an NFT position, and its job here is to be the SINGLE source
 * both the preload pass and the real pass consult.
 */

import { describe, it, expect } from "vitest";

import {
  feeGate,
  shouldTraceFees,
  traceGateCanPass,
  traceGateForRow,
  type FeeGateEvent,
} from "./utils/feeGate";
import { getFeesAccrued, getFeesAccruedRetry } from "./effects/feesAccrued";
import { getTokenMetadata } from "./utils/tokenMetadata";
import { newPosition } from "./utils/positions";

/** Avalanche, whose PositionManager is the one the tokenId-137 case ran through. */
const AVALANCHE = 43114;
const AVAX_POSITION_MANAGER = "0xB74b1F14d2754AcfcbBe1a221023a5cf50Ab8ACD";

function evt(over: Partial<FeeGateEvent> = {}): FeeGateEvent {
  return {
    chainId: AVALANCHE,
    // Checksummed, as Envio delivers it — `address_format` defaults to
    // `checksum` and config.yaml does not override it, so a gate that compared
    // without lowercasing would reject every real event.
    sender: AVAX_POSITION_MANAGER,
    salt: "0x" + (137).toString(16).padStart(64, "0"),
    ...over,
  };
}

describe("shouldTraceFees — the gate on the only exact fee source", () => {
  /*
   * THE GATE IS NOW ONE CONJUNCT, AND THE TESTS BELOW PIN THAT IT STAYS THAT
   * WAY.
   *
   * It used to read `gateCanPass && (feeGrowthChanged || liquidityDelta < 0n)`.
   * Both disjuncts were removed after all 1,167 wrong Avalanche positions were
   * traced against chain truth: the gate alone left 750 of them wrong, and it
   * is `feeGrowthChanged` that suppressed those traces.
   *
   * `feeGrowthChanged` is not a conservative heuristic — it is UNSOUND. It
   * compares a POOL-level `feeGrowthInside` sampled at END OF BLOCK against a
   * fee determined by the POSITION's own MID-TRANSACTION checkpoint. They
   * diverge permanently at mint (43114_1356) and block granularity cannot see
   * accrual inside the settling block (43114_378).
   *
   * `liquidityDelta < 0n` was the earlier partial fix and is false for the
   * 69.9% of fee-bearing settlements that are zero-delta pure collects, and for
   * the 96 fee-bearing POSITIVE-delta frames — 43114_3132 being the
   * counterexample to the claim, made in the old docstring, that the INCREASE
   * path was safe.
   */
  it("traces on gateCanPass ALONE, for every liquidity delta", () => {
    // The three shapes the old predicate treated differently: a decrease, a
    // zero-delta pure collect (69.9% of fee-bearing settlements), and an
    // increase (96 fee-bearing frames). All must trace now.
    expect(shouldTraceFees({ gateCanPass: true })).toBe(true);
  });

  it("does NOT trace when gateCanPass is false", () => {
    // The one surviving conjunct, and the reason this is affordable: a mint has
    // no prior position and therefore provably no feesAccrued, which keeps the
    // positive-delta majority off the trace path. Measured cost of the widened
    // gate over all of chain 43114: +7,381 traces, at most 1.6x.
    expect(shouldTraceFees({ gateCanPass: false })).toBe(false);
  });

  it("takes NOTHING but gateCanPass, so the removed heuristics cannot be reintroduced", () => {
    /*
     * A TYPE TEST WORTH WRITING. The defect was not that someone chose a bad
     * predicate once; it is that `feeGrowthChanged` and `liquidityDelta` read
     * like free, obviously-safe skips, and a future "cheap optimisation" patch
     * would reach for exactly them again. Removing them from the ARGUMENT TYPE
     * is what makes that a compile error rather than a silent 750-position
     * regression, so the argument type is asserted here explicitly.
     */
    expect(Object.keys(shouldTraceFees)).toEqual([]);
    expect(shouldTraceFees.length).toBe(1);
    // @ts-expect-error — `feeGrowthChanged` must not be accepted any more.
    expect(shouldTraceFees({ gateCanPass: true, feeGrowthChanged: false })).toBe(true);
    // @ts-expect-error — nor `liquidityDelta`.
    expect(shouldTraceFees({ gateCanPass: true, liquidityDelta: 5_000n })).toBe(true);
  });
});

describe("feeGate — one predicate for the preload pass and the real path", () => {
  it("attributes a PositionManager event to its tokenId", () => {
    expect(feeGate(evt())).toEqual({ attributable: true, tokenId: 137n });
  });

  it("refuses to attribute a non-PositionManager caller", () => {
    // `salt` is a caller-supplied bytes32; only the PositionManager makes it a
    // tokenId.
    const d = feeGate(evt({ sender: "0x000000000000000000000000000000000000dEaD" }));
    expect(d).toEqual({ attributable: false, tokenId: undefined });
  });

  it("refuses on a chain with no PositionManager entry", () => {
    expect(feeGate(evt({ chainId: 31337 })).attributable).toBe(false);
  });

  it("treats a zero salt as no tokenId, but still attributable", () => {
    // Zero is the default salt for direct liquidity provision, not a minted id.
    const d = feeGate(evt({ salt: "0x" + "0".repeat(64) }));
    expect(d.attributable).toBe(true);
    expect(d.tokenId).toBeUndefined();
  });

  it("is deterministic: the same input always yields the same decision", () => {
    for (const over of [
      {},
      { sender: "0x000000000000000000000000000000000000dEaD" },
      { salt: "0x" + "0".repeat(64) },
      { chainId: 1 },
    ] as Partial<FeeGateEvent>[]) {
      expect(feeGate(evt(over))).toEqual(feeGate(evt(over)));
    }
  });
});

describe("effect options that are load-bearing rather than cosmetic", () => {
  /*
   * Asserted against the RUNTIME shape `createEffect` produces
   * (`Envio.res.mjs:22-51`), not the literal passed in — that is what the
   * indexer actually reads.
   */
  type EffectInternals = {
    readonly name: string;
    readonly defaultShouldCache: boolean;
    readonly crossChain?: boolean;
    readonly rateLimit?: { callsPerDuration: number; durationMs: number };
  };
  it("EVERY effect is chain-scoped, and none carries chainId in its key", () => {
    /*
     * The two halves are one invariant. Chain-scoped puts each chain's rows in
     * its own table and its own `<chainId>/` .tsv directory; dropping `chainId`
     * from the input stops it ALSO being a key field, where it only partitioned
     * rows inside a single flat file. A new effect that keeps `chainId` in its
     * input silently reintroduces the flat-file shape.
     */
    const effects = [
      ["getFeesAccrued", getFeesAccrued as unknown as EffectInternals],
      ["getFeesAccruedRetry", getFeesAccruedRetry as unknown as EffectInternals],
      ["getTokenMetadata", getTokenMetadata as unknown as EffectInternals],
    ] as const;

    for (const [name, e] of effects) {
      expect(e.crossChain, `${name} must declare crossChain: false`).toBe(false);
    }
  });

  it("getFeesAccrued keeps its cache identity: name, cache, scope and limit", () => {
    /*
     * The persisted trace cache (5M+ rows) is addressed by the effect NAME and
     * scope — the table is `envio_<chain>_effect_getFeesAccrued` — and keyed on
     * the input. Sharing the handler with `getFeesAccruedRetry` must not move
     * any of it. There is no migration between cache tables.
     */
    const fees = getFeesAccrued as unknown as EffectInternals;
    expect(fees.name).toBe("getFeesAccrued");
    expect(fees.defaultShouldCache).toBe(true);
    expect(fees.crossChain).toBe(false);
    expect(fees.rateLimit).toEqual({ callsPerDuration: 20, durationMs: 1000 });
  });

  it("getFeesAccruedRetry is a DIFFERENT effect and stays uncached", () => {
    /*
     * A different NAME is the whole mechanism: a second memo, so the real pass
     * is not served the prefetch's degraded `[]` again. Uncached because the
     * primary table is the authority — a success persisted under this name
     * would never be read by `getFeesAccrued` on a resync, and an uncached
     * effect never creates a table.
     */
    const retry = getFeesAccruedRetry as unknown as EffectInternals;
    expect(retry.name).toBe("getFeesAccruedRetry");
    expect(retry.name).not.toBe((getFeesAccrued as unknown as EffectInternals).name);
    expect(retry.defaultShouldCache).toBe(false);
  });
});

describe("traceGateForRow — the trace gate both passes evaluate", () => {
  /*
   * The preload pass prefetches `getFeesAccrued` when this says yes against the
   * BATCH-START row; the real pass decides with it against the running row. It
   * must be exactly `traceGateCanPass` over the row the real pass builds, or the
   * two passes drift into wasted traces or serial misses.
   */
  const pos = (poolId: string, liquidity: bigint) => ({
    ...newPosition({
      id: "1_1",
      chainId: 1n,
      tokenId: 1n,
      owner: "0x",
      origin: "0x",
      timestamp: 0n,
      blockNumber: 0n,
    }),
    poolId,
    liquidity,
  });
  const DELTAS = [-(10n ** 20n), -1n, 0n, 1n, 10n ** 20n];

  it("an absent row answers exactly as the newPosition() the real pass substitutes", () => {
    // Unmodified: this must fail if newPosition()'s poolId/liquidity defaults
    // ever drift from the `undefined` mapping inside traceGateForRow.
    const stub = newPosition({
      id: "1_1",
      chainId: 1n,
      tokenId: 1n,
      owner: "0x",
      origin: "0x",
      timestamp: 0n,
      blockNumber: 0n,
    });
    for (const d of DELTAS) {
      expect(traceGateForRow(undefined, d), `delta ${d}`).toBe(traceGateForRow(stub, d));
      expect(traceGateForRow(undefined, d), `delta ${d}`).toBe(
        traceGateCanPass({ hadPosition: stub.poolId !== "", storedLiquidity: stub.liquidity, liquidityDelta: d }),
      );
    }
  });

  it("equals traceGateCanPass on every stored row shape", () => {
    for (const poolId of ["", "0xpool"]) {
      for (const liquidity of [0n, 1n, 10n ** 24n]) {
        for (const d of DELTAS) {
          const row = pos(poolId, liquidity);
          expect(traceGateForRow(row, d), `${poolId || "stub"} L=${liquidity} d=${d}`).toBe(
            traceGateCanPass({ hadPosition: poolId !== "", storedLiquidity: liquidity, liquidityDelta: d }),
          );
        }
      }
    }
  });

  it("never prefetches a mint — the reason mints stay off the 20/s window", () => {
    expect(traceGateForRow(undefined, 1n)).toBe(false);
    expect(traceGateForRow(pos("", 0n), 10n ** 20n)).toBe(false);
  });

  it("matches the external proposal's inline predicate on every reachable row", () => {
    /*
     * Proposed inline as `delta <= 0n || (pos?.liquidity ?? 0n) > 0n`. Reachable
     * rows are: none, a Transfer stub ("", 0), a closed position (x, 0) and a
     * live one (x, > 0). The two agree on all of them; the inline form is only
     * looser on unreachable ("", > 0), where the real gate rejects anyway. The
     * helper is used instead so the predicate exists once.
     */
    const inline = (row: { liquidity: bigint } | undefined, d: bigint) =>
      d <= 0n || (row?.liquidity ?? 0n) > 0n;
    const reachable = [undefined, pos("", 0n), pos("0xpool", 0n), pos("0xpool", 5n)];
    for (const row of reachable) {
      for (const d of DELTAS) {
        expect(traceGateForRow(row, d)).toBe(inline(row, d));
      }
    }
  });

  it("pins the two in-batch drift directions — cost only, the real pass decides", () => {
    // Minted earlier in the batch, then increased: snapshot has no row.
    expect(traceGateForRow(undefined, 5n)).toBe(false); // preload: not prefetched
    expect(traceGateForRow(pos("0xpool", 10n ** 20n), 5n)).toBe(true); // real pass: traces (serial miss)

    // Fully withdrawn earlier in the batch, then re-added: snapshot still live.
    expect(traceGateForRow(pos("0xpool", 5n), 5n)).toBe(true); // preload: prefetched
    expect(traceGateForRow(pos("0xpool", 0n), 5n)).toBe(false); // real pass: never read (waste)
  });
});
