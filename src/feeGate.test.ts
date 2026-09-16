/**
 * Unit tests for the two ModifyLiquidity fee gates (`src/utils/feeGate.ts`).
 *
 * Same rationale as positionGuards.test.ts: each of these exists to prevent a
 * specific PLAUSIBLE WRONG NUMBER — a zero that looks like data. A snapshot
 * test cannot fail on a fee that was never measured; it records the zero.
 *
 * `shouldTraceFees` is the gate on `debug_traceTransaction`, which is the only
 * source of the exact collected fee. `feeGate` is the gate on
 * `getPositionInfoAt`, and its job here is to be the SINGLE source both the
 * preload pass and the real pass consult.
 */

import { describe, it, expect, vi } from "vitest";

import {
  feeGate,
  readPositionBaseline,
  shouldTraceFees,
  type FeeGateEvent,
} from "./utils/feeGate";
import { getPositionInfoAt, getPositionFeeGrowthBatch } from "./effects/positionState";
import { TickMath } from "./utils/liquidityMath/tickMath";

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
      chainId: AVALANCHE,
      poolId: POOL_ID,
      tickLower: -887220,
      tickUpper: 887220,
      blockNumber: 57816979n,
    });
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

  it("STILL READS on a degenerate pool — the baseline is storage, not tick math", () => {
    /*
     * REVERSED, deliberately. This test used to assert `read === false` here,
     * and that skip cost real data.
     *
     * The read is `getPositionInfo`, a mapping load out of PoolManager storage.
     * It performs no tick math and never touches `sqrtPriceX96`, so a pool
     * parked at the domain edge does not make it meaningless — it returns a
     * perfectly well-defined checkpoint. The repo already makes exactly this
     * argument for `feesAccrued` in `traceGateCanPass`; it was never carried
     * across to here.
     *
     * Measured on Avalanche at block 60,970,065: tokenId 239 stores
     * `feeGrowthInside0LastX128 = 0` against a contract value of
     * 55046743943002458572625538413, because its pool collapsed to MIN_TICK
     * between the mint and the later events and both were gated. The closing
     * burn then cleared the tick pair, so `getFeeGrowthInside` reads (0,0) there
     * too — this read is the ONLY one that recovers the truth.
     *
     * The handler still zeroes tick-DERIVED valuations and sets
     * `isPriceable: false`; that is a separate decision, made where the tick
     * math actually happens.
     */
    for (const over of [
      { poolTick: TickMath.MIN_TICK },
      { poolTick: TickMath.MAX_TICK },
      { poolSqrtPrice: 0n },
      { poolSqrtPrice: TickMath.MAX_SQRT_RATIO },
    ]) {
      const d = feeGate(evt(over));
      expect(d.attributable).toBe(true);
      expect(d.tokenId).toBe(137n);
      expect(d.read).toBe(true);
      expect(d.effectInput).toBeDefined();
    }
  });

  it("reads regardless of which pool price fields are absent", () => {
    /*
     * `pool.tick` and `pool.sqrtPrice` are nullable in the schema. Neither can
     * suppress the read any more, because neither is an input to it: the effect
     * is keyed on poolId, owner, ticks, salt and block, none of which come from
     * the pool's price.
     *
     * Both earlier versions of this test turned on `isDegenerate`, and the one
     * before that had the polarity backwards. There is nothing left to get
     * backwards — the answer is now the same either way.
     */
    expect(feeGate(evt({ poolTick: undefined })).read).toBe(true);
    expect(feeGate(evt({ poolTick: undefined, poolSqrtPrice: undefined })).read).toBe(true);
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

  it("CANNOT drift across passes any more: pool price state no longer gates the read", async () => {
    /*
     * This test used to pin a real cost. A swap earlier in the same batch can
     * move a pool across the `isDegenerate` boundary between the preload read
     * (the DB row) and the real read (in-batch writes), and while pool price was
     * a GATE that meant the two passes disagreed about whether to read at all —
     * measured preload=0, real=1 — so the real pass missed the warm and paid one
     * RPC inside the serial loop.
     *
     * Removing the degenerate gate removes the divergence with it. Pool price is
     * now neither a gate nor part of the memo key, so both passes issue the same
     * call with the same input whatever the price did in between. Both halves
     * are asserted: same decision, and the same effect invocation.
     */
    const effect = vi.fn(async (_effect: unknown, _input: unknown) => ({
      ok: true,
      liquidity: 3n,
      feeGrowthInside0LastX128: 1n,
      feeGrowthInside1LastX128: 2n,
    }));
    const context = { effect } as unknown as Parameters<typeof readPositionBaseline>[0];

    const degenerateAtPreload = evt({ poolSqrtPrice: 0n });
    const healthyAtReal = evt();

    expect(feeGate(degenerateAtPreload).effectInput).toEqual(
      feeGate(healthyAtReal).effectInput,
    );

    await readPositionBaseline(context, degenerateAtPreload);
    await readPositionBaseline(context, healthyAtReal);

    expect(effect).toHaveBeenCalledTimes(2);
    expect(effect.mock.calls[0]![0]).toBe(getPositionInfoAt);
    expect(effect.mock.calls[0]![1]).toEqual(effect.mock.calls[1]![1]);
  });

  it("issues NOTHING when the gate says no, in either pass", async () => {
    /*
     * Two gates remain, and neither depends on pool state: a non-PositionManager
     * sender (not attributable at all) and a salt that carries no tokenId. This
     * case used to use a degenerate pool, which no longer gates anything.
     */
    const effect = vi.fn();
    const context = { effect } as unknown as Parameters<typeof readPositionBaseline>[0];
    const notPositionManager = evt({
      sender: "0x000000000000000000000000000000000000dEaD",
    });

    expect(await readPositionBaseline(context, notPositionManager)).toBeUndefined();
    expect(await readPositionBaseline(context, notPositionManager)).toBeUndefined();
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
  const inside = getPositionInfoAt as unknown as EffectInternals;
  const batch = getPositionFeeGrowthBatch as unknown as EffectInternals;

  it("getPositionInfoAt rate-limits above the five-chain shared floor, but not so wide the request is rejected", () => {
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

  it("getPositionInfoAt keeps its cache and its crossChain scope", () => {
    // NOT because crossChain: true is better — because the cache table name
    // encodes the scope (`Internal.res.mjs:222-228`), so flipping it silently
    // ORPHANS every cached row. `rateLimit` is the runtime-only knob; this
    // makes the scope an explicit decision rather than an accident.
    expect(inside.defaultShouldCache).toBe(true);
    expect(inside.crossChain).toBeUndefined();
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
});
