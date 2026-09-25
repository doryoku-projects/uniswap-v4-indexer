/**
 * Unit tests for the two ModifyLiquidity fee gates (`src/utils/feeGate.ts`).
 *
 * Same rationale as positionGuards.test.ts: each of these exists to prevent a
 * specific PLAUSIBLE WRONG NUMBER — a zero that looks like data. A snapshot
 * test cannot fail on a fee that was never measured; it records the zero.
 *
 * `shouldTraceFees` is the gate on `debug_traceTransaction`, which is the only
 * source of the exact collected fee. `feeGate` is the gate on
 * `getFeeGrowthInside`, and its job here is to be the SINGLE source both the
 * preload pass and the real pass consult.
 */

import { describe, it, expect, vi } from "vitest";

import {
  feeGate,
  readFeeGrowthInside,
  shouldTraceFees,
  traceGateCanPass,
  traceGateForRow,
  type FeeGateEvent,
} from "./utils/feeGate";
import { getFeeGrowthInside, getPositionFeeGrowthBatch } from "./effects/positionState";
import { getFeesAccrued, getFeesAccruedRetry } from "./effects/feesAccrued";
import { getTokenMetadata } from "./utils/tokenMetadata";
import { TickMath } from "./utils/liquidityMath/tickMath";
import { newPosition } from "./utils/positions";

/** Avalanche, whose PositionManager is the one the tokenId-137 case ran through. */
const AVALANCHE = 43114;
const AVAX_POSITION_MANAGER = "0xB74b1F14d2754AcfcbBe1a221023a5cf50Ab8ACD";
const MID_SQRT = 79228162514264337593543950336n; // price 1.0
const POOL_ID = "0x" + "ab".repeat(32);

function evt(over: Partial<FeeGateEvent> = {}): FeeGateEvent {
  return {
    chainId: AVALANCHE,
    // Checksummed, as Envio delivers it — `address_format` defaults to
    // `checksum` and config.yaml does not override it, so a gate that compared
    // without lowercasing would reject every real event.
    sender: AVAX_POSITION_MANAGER,
    salt: "0x" + (137).toString(16).padStart(64, "0"),
    poolId: POOL_ID,
    tickLower: -887220n,
    tickUpper: 887220n,
    blockNumber: 57816979,
    poolTick: 0n,
    poolSqrtPrice: MID_SQRT,
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
  it("passes for a PositionManager event on an ordinary pool", () => {
    const d = feeGate(evt());
    expect(d.attributable).toBe(true);
    expect(d.tokenId).toBe(137n);
    expect(d.read).toBe(true);
    expect(d.effectInput).toMatchObject({
      poolId: POOL_ID,
      tickLower: -887220,
      tickUpper: 887220,
      blockNumber: 57816979n,
    });
    // NO `chainId`. The effect is chain-scoped, so the chain is the cache table
    // and the .tsv directory; the handler reads it from `context.chain.id`.
    // Putting it back would partition rows INSIDE one file instead of across
    // files, and would change every cache key.
    expect(d.effectInput).not.toHaveProperty("chainId");
    // The StateView must actually resolve, or every read degrades to ok:false
    // and every event traces.
    expect(d.effectInput?.stateView).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("refuses to attribute a non-PositionManager caller", () => {
    // `salt` is a caller-supplied bytes32; only the PositionManager makes it a
    // tokenId. Reading fee growth for one would be an RPC spent on a row that
    // is never written.
    const d = feeGate(evt({ sender: "0x000000000000000000000000000000000000dEaD" }));
    expect(d).toEqual({
      attributable: false,
      tokenId: undefined,
      read: false,
      effectInput: undefined,
    });
  });

  it("refuses on a chain with no PositionManager entry", () => {
    const d = feeGate(evt({ chainId: 31337 }));
    expect(d.attributable).toBe(false);
    expect(d.read).toBe(false);
  });

  it("treats a zero salt as no tokenId, but still attributable", () => {
    // Zero is the default salt for direct liquidity provision, not a minted id.
    const d = feeGate(evt({ salt: "0x" + "0".repeat(64) }));
    expect(d.attributable).toBe(true);
    expect(d.tokenId).toBeUndefined();
    expect(d.read).toBe(false);
  });

  it("skips the read on a degenerate pool but still reports the tokenId", () => {
    // The tokenId is still needed: the real path writes the Position row for a
    // degenerate pool too, with zeroed amounts and isPriceable false. Only the
    // fee READ is pointless there.
    for (const over of [
      { poolTick: TickMath.MIN_TICK },
      { poolTick: TickMath.MAX_TICK },
      { poolSqrtPrice: 0n },
      { poolSqrtPrice: TickMath.MAX_SQRT_RATIO },
    ]) {
      const d = feeGate(evt(over));
      expect(d.attributable).toBe(true);
      expect(d.tokenId).toBe(137n);
      expect(d.read).toBe(false);
      expect(d.effectInput).toBeUndefined();
    }
  });

  it("reads on an absent tick alone, but a pool missing BOTH fields is degenerate and is not read", () => {
    /*
     * `pool.tick` is nullable in the schema and `?? 0n` is what the handler
     * passed before the extraction; 0 is an ordinary in-domain tick, so an
     * absent tick on its own does not suppress the read.
     *
     * Both absent is the opposite case, and the earlier title of this test had
     * it backwards. `isDegenerate` compares sqrtPrice against
     * TickMath.MIN_SQRT_RATIO (4295128739n), and `?? 0n` makes an absent
     * sqrtPrice 0, which is <= that bound — so the pool IS degenerate and the
     * read IS skipped. That is deliberate, not an oversight: with no price
     * there is nothing to read against.
     */
    expect(feeGate(evt({ poolTick: undefined })).read).toBe(true);
    expect(feeGate(evt({ poolTick: undefined, poolSqrtPrice: undefined })).read).toBe(false);
  });

  /*
   * THE POINT OF THE EXTRACTION — stated accurately.
   *
   * An earlier version of this comment claimed the two passes "call the SAME
   * function with the SAME object, so they cannot disagree". THAT IS FALSE, and
   * the test below it was a tautology that could never have caught it.
   *
   * `feeGateEvent` is built per pass from `existingPool`, i.e. from
   * `context.Pool.get(poolId)`. In the PRELOAD pass that reads the DB row,
   * because preload writes are discarded (`set` is `noopSet`,
   * UserContext.res.mjs:102). In the REAL pass it reads
   * `latestEntityChangeById`, which earlier handlers in the same batch have
   * already updated — `swap-handler.ts` assigns `tick` and `sqrtPrice` from the
   * swap event. So a swap earlier in the batch CAN move a pool across the
   * `isDegenerate` boundary between the two passes.
   *
   * What that costs, precisely: `poolTick` / `poolSqrtPrice` gate WHETHER the
   * read is issued; they are NOT part of the effect input, so they cannot
   * produce a different memo key and cannot produce a wrong answer. Drift
   * degrades to today's behaviour — the real pass misses the warm and pays one
   * RPC inside the serial loop. Measured: preload=0, real=1 for a pool
   * degenerate at preload and healthy at real.
   *
   * The two tests below pin exactly that: the memo key must be independent of
   * pool price state, and the gate is allowed to differ across passes.
   */
  it("is deterministic: the same input always yields the same decision", () => {
    for (const over of [
      {},
      { sender: "0x000000000000000000000000000000000000dEaD" },
      { poolTick: TickMath.MIN_TICK },
      { salt: "0x" + "0".repeat(64) },
      { chainId: 1 },
    ] as Partial<FeeGateEvent>[]) {
      expect(feeGate(evt(over))).toEqual(feeGate(evt(over)));
    }
  });

  it("keys the effect input independently of pool price state, so the two passes cannot miss each other's memo", () => {
    /*
     * THE TEST THAT ACTUALLY BITES. Two events identical except for the pool
     * price state the two passes can legitimately disagree about. If either
     * `poolTick` or `poolSqrtPrice` ever leaks into the effect input, the real
     * pass computes a DIFFERENT memo key from the preload pass, misses the
     * warm on every event, and the hoist silently buys nothing.
     */
    const healthy = evt({ poolTick: 100n, poolSqrtPrice: 79228162514264337593543950336n });
    const alsoHealthy = evt({ poolTick: -8000n, poolSqrtPrice: 52959464864425783n });

    const a = feeGate(healthy);
    const b = feeGate(alsoHealthy);

    expect(a.read).toBe(true);
    expect(b.read).toBe(true);
    expect(a.effectInput).toEqual(b.effectInput);
  });

  it("lets the gate differ across passes without changing the answer — drift costs a warm miss, never a wrong fee", async () => {
    /*
     * A swap earlier in the same batch can move a pool across the isDegenerate
     * boundary between the preload read (DB row) and the real read (in-batch
     * writes). Pin the consequence: the degenerate pass issues nothing, the
     * healthy pass issues exactly the input it would have issued anyway.
     */
    const effect = vi.fn(async (_effect: unknown, _input: unknown) => ({
      ok: true,
      feeGrowthInside0X128: 1n,
      feeGrowthInside1X128: 2n,
    }));
    const context = { effect } as unknown as Parameters<typeof readFeeGrowthInside>[0];

    const degenerateAtPreload = evt({ poolSqrtPrice: 0n });
    const healthyAtReal = evt();

    expect(await readFeeGrowthInside(context, degenerateAtPreload)).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(0);

    await readFeeGrowthInside(context, healthyAtReal);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect.mock.calls[0]![0]).toBe(getFeeGrowthInside);
    expect(effect.mock.calls[0]![1]).toEqual(feeGate(healthyAtReal).effectInput);
  });

  it("issues NOTHING when the gate says no, in either pass", async () => {
    const effect = vi.fn();
    const context = { effect } as unknown as Parameters<typeof readFeeGrowthInside>[0];
    const closed = evt({ poolTick: TickMath.MIN_TICK });

    expect(await readFeeGrowthInside(context, closed)).toBeUndefined();
    expect(await readFeeGrowthInside(context, closed)).toBeUndefined();
    expect(effect).not.toHaveBeenCalled();
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
  const inside = getFeeGrowthInside as unknown as EffectInternals;
  const batch = getPositionFeeGrowthBatch as unknown as EffectInternals;

  it("getFeeGrowthInside rate-limits above the five-chain shared floor, but not so wide the request is rejected", () => {
    /*
     * Two-sided, because this number is bounded from BOTH directions and a
     * previous version of this change got the upper bound wrong.
     *
     * FLOOR. Once the read is hoisted into the preload pass the limiter, not
     * RPC latency, is the ceiling on throughput. config.yaml sets no
     * `disable_default_cross_chain`, so `crossChain` defaults to true and ONE
     * window is shared by every chain — the old 100/s was ~20/s each across the
     * five uncommented chains. At or below 100 is a regression of Part C.
     *
     * CEILING. `LoadLayer.executeWithRateLimit` releases `availableCalls`
     * simultaneously, so this number maps ONE-FOR-ONE onto the width of the
     * JSON-RPC body viem sends. Measured: n=600 at calls=100 gave 6 POSTs of
     * width 100; at calls=500, 2 POSTs of width 500. A 500-wide `eth_call` body
     * invites a provider rejection, and a 429 here returns `ok: false`, which
     * FORCES a trace — and if that trace also fails the fee is recorded as a
     * silent ZERO. So an over-wide limit is a correctness risk, not just a
     * throughput knob, on an indexer whose hard requirement is exact fees.
     */
    expect(inside.rateLimit).toEqual({ callsPerDuration: 200, durationMs: 1000 });
    expect(inside.rateLimit!.callsPerDuration).toBeGreaterThan(100);
    expect(inside.rateLimit!.callsPerDuration).toBeLessThanOrEqual(250);
  });

  it("getFeeGrowthInside is cached and CHAIN-SCOPED", () => {
    /*
     * Was `crossChain` undefined — i.e. inherited from `config.defaultCrossChain`
     * — which made this cache's identity a property of config.yaml rather than of
     * its own source, so upstream's `disable_default_cross_chain: true` would
     * strand it on a merge with no error. Now stated locally.
     *
     * The scope is also what makes `context.chain.id` readable in the handler:
     * it THROWS on a cross-chain effect (envio/index.d.ts:66-68). So reverting
     * this line breaks the handler, not just the cache path.
     *
     * Flipping it is never free — the table NAME encodes the scope
     * (`Internal.res.mjs:222-228`), so each flip strands every cached row.
     */
    expect(inside.defaultShouldCache).toBe(true);
    expect(inside.crossChain).toBe(false);
  });

  it("EVERY effect is chain-scoped, and none carries chainId in its key", () => {
    /*
     * The two halves are one invariant. Chain-scoped puts each chain's rows in
     * its own table and its own `<chainId>/` .tsv directory; dropping `chainId`
     * from the input stops it ALSO being a key field, where it only partitioned
     * rows inside a single flat file. A new effect that keeps `chainId` in its
     * input silently reintroduces the flat-file shape.
     */
    const effects = [
      ["getFeeGrowthInside", inside],
      ["getPositionFeeGrowthBatch", batch],
      ["getFeesAccrued", getFeesAccrued as unknown as EffectInternals],
      ["getFeesAccruedRetry", getFeesAccruedRetry as unknown as EffectInternals],
      ["getTokenMetadata", getTokenMetadata as unknown as EffectInternals],
    ] as const;

    for (const [name, e] of effects) {
      expect(e.crossChain, `${name} must declare crossChain: false`).toBe(false);
    }
  });

  it("getPositionFeeGrowthBatch must stay uncached", () => {
    /*
     * Not a preference. `UserContext.res.mjs:61` builds the cache key with
     * `Utils.Hash.makeOrThrow`, which is a canonical serialiser rather than a
     * digest (`Utils.res.mjs:559-620`), and that string IS the row id of a
     * table whose only columns are `id` (String PRIMARY KEY) and `output`
     * (`Internal.res.mjs:315-320`). The input here is a 400-position array, so
     * the key runs to tens of kilobytes against Postgres's 2704-byte btree
     * limit: `cache: true` is a StorageError on first write, not a wasted row.
     */
    expect(batch.defaultShouldCache).toBe(false);
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
