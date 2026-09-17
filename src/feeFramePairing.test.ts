/**
 * THE NO-DOUBLE-COUNT TEST, and the shapes that made it necessary.
 *
 * WHAT IS BEING PINNED. A Uniswap v4 settlement emits TWO ModifyLiquidity events
 * for the SAME salt inside one transaction — the first with `liquidityDelta == 0`
 * carrying ALL the fees, the second with the real delta carrying (0, 0). The
 * handler must attribute each event to ITS OWN call frame, so that across the
 * same-salt events of one transaction the attributed fees sum to exactly the
 * fees in that transaction's frames: no more, no less.
 *
 * Both obvious pickers fail that invariant, in opposite directions:
 *
 *   LAST-wins  (`[...fees].reverse().find(salt)`, what shipped) selects the ZERO
 *              frame — measured on Avalanche as a zero-fee frame in 1,163 of
 *              2,087 cases, and 101/101 traced multi-event transactions had the
 *              fee on the FIRST frame and exactly zero on the last.
 *   FIRST-wins (`fees.find(salt)`) is not the fix: once the trace gate is
 *              widened BOTH same-salt events trace, so both resolve to the same
 *              first frame and the fee is counted TWICE.
 *
 * Field matching is not the fix either: 35 Avalanche transactions carry two
 * frames identical in salt + ticks + delta (tx 0x44e8625d81, position 43114_7842
 * among them), so no combination of those fields separates them.
 *
 * Each test below drives the REAL production path end to end — a synthetic
 * callTracer trace through `framesFromTrace` (which assigns the ordinals), then
 * `saltOrdinal` + `pickFeeFrame` per event, exactly as the handler does, with
 * the entity store grown between events the way the strictly serial real pass
 * grows it.
 *
 * The counts in each shape's title are from the audited Avalanche population
 * (all 1,167 affected positions, all ~2,062 settlement transactions decoded).
 */

import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeFunctionData } from "viem";

import { MODIFY_LIQ_ABI, framesFromTrace, type ModifyFrame } from "./effects/feesAccrued";
import { pickFeeFrame, saltOrdinal, type PriorModifyRow } from "./utils/feeFrames";
import { traceGateCanPass } from "./utils/feeGate";

const POOL_MANAGER = "0x06380c0e0912312b5150364b9dc4542ba0dbbc85"; // Avalanche
const ROUTER = "0x1111111111111111111111111111111111111111";
const CHAIN = 43114;

const TICKS = { tickLower: -887220, tickUpper: 887220 } as const;

interface FrameSpec {
  readonly tokenId: bigint;
  readonly liquidityDelta: bigint;
  readonly fee0: bigint;
  readonly fee1: bigint;
  readonly tickLower?: number;
  readonly tickUpper?: number;
}

const saltOf = (tokenId: bigint) => `0x${tokenId.toString(16).padStart(64, "0")}`;

/** v4 packs two int128s into one int256: amount0 high, amount1 low. */
function packDelta(amount0: bigint, amount1: bigint): bigint {
  return BigInt.asIntN(256, (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1));
}

/**
 * One `PoolManager.modifyLiquidity` call frame, encoded with the SAME abi the
 * effect decodes with — so a test cannot pass against a shape production does
 * not actually read.
 */
function frameNode(spec: FrameSpec) {
  return {
    to: POOL_MANAGER,
    input: encodeFunctionData({
      abi: MODIFY_LIQ_ABI,
      functionName: "modifyLiquidity",
      args: [
        {
          currency0: "0x0000000000000000000000000000000000000000",
          currency1: "0x0000000000000000000000000000000000000001",
          fee: 3000,
          tickSpacing: 60,
          hooks: "0x0000000000000000000000000000000000000000",
        },
        {
          tickLower: spec.tickLower ?? TICKS.tickLower,
          tickUpper: spec.tickUpper ?? TICKS.tickUpper,
          liquidityDelta: spec.liquidityDelta,
          salt: saltOf(spec.tokenId) as `0x${string}`,
        },
        "0x",
      ],
    }),
    // callerDelta then feesAccrued — the effect reads the SECOND word.
    output: encodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }],
      [packDelta(-1n, -2n), packDelta(spec.fee0, spec.fee1)],
    ),
  };
}

/** A realistic router transaction: the PoolManager frames nested under a call. */
function traceOf(specs: readonly FrameSpec[]) {
  return {
    to: ROUTER,
    input: "0xdeadbeef",
    calls: specs.map((s) => ({ to: ROUTER, input: "0xcafe", calls: [frameNode(s)] })),
  };
}

interface EventSpec {
  readonly tokenId: bigint;
  readonly logIndex: number;
  readonly liquidityDelta: bigint;
  readonly tickLower?: number;
  readonly tickUpper?: number;
}

interface Attribution {
  readonly logIndex: number;
  readonly ordinal: number;
  readonly status: string;
  readonly fee0: bigint;
  readonly fee1: bigint;
}

/**
 * Replay one transaction the way the REAL PASS does it: events in log order,
 * each one first writing its ModifyLiquidity row (the handler does that before
 * the position block) and then pairing itself against the trace.
 *
 * `rows` grows as the pass proceeds, which is the whole mechanism — the ordinal
 * is a count over rows that already exist, never a counter held in a variable.
 */
function replayTransaction(frames: readonly ModifyFrame[], events: readonly EventSpec[]) {
  const rows: PriorModifyRow[] = [];
  const out: Attribution[] = [];
  for (const e of events) {
    const key = {
      chainId: CHAIN,
      salt: saltOf(e.tokenId),
      logIndex: e.logIndex,
      tickLower: BigInt(e.tickLower ?? TICKS.tickLower),
      tickUpper: BigInt(e.tickUpper ?? TICKS.tickUpper),
      liquidityDelta: e.liquidityDelta,
    };
    // The handler writes the entity BEFORE it pairs. Counting strictly-lower log
    // indices is what makes that harmless, so the row is added first here too.
    rows.push({ chainId: BigInt(CHAIN), salt: key.salt, logIndex: BigInt(e.logIndex) });
    const ordinal = saltOrdinal(rows, key);
    const pick = pickFeeFrame(frames, key, ordinal);
    out.push({
      logIndex: e.logIndex,
      ordinal,
      status: pick.status,
      fee0: pick.status === "matched" ? pick.frame.amount0 : 0n,
      fee1: pick.status === "matched" ? pick.frame.amount1 : 0n,
    });
  }
  return out;
}

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** THE invariant: attributed total === traced total, for one salt. */
function expectConserved(
  frames: readonly ModifyFrame[],
  attributed: readonly Attribution[],
  tokenId: bigint,
) {
  const mine = frames.filter((f) => f.salt === tokenId.toString());
  expect(sum(attributed.map((a) => a.fee0))).toBe(sum(mine.map((f) => f.amount0)));
  expect(sum(attributed.map((a) => a.fee1))).toBe(sum(mine.map((f) => f.amount1)));
}

describe("framesFromTrace — ordinals in execution order", () => {
  it("numbers same-salt frames 0,1,… and keeps unrelated salts on their own sequence", () => {
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 7n, liquidityDelta: 0n, fee0: 5n, fee1: 6n },
        { tokenId: 9n, liquidityDelta: 0n, fee0: 1n, fee1: 0n },
        { tokenId: 7n, liquidityDelta: -100n, fee0: 0n, fee1: 0n },
        { tokenId: 9n, liquidityDelta: -1n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    expect(frames.map((f) => [f.salt, f.ordinal])).toEqual([
      ["7", 0],
      ["9", 0],
      ["7", 1],
      ["9", 1],
    ]);
    // Execution order preserved, not sorted or grouped by salt.
    expect(frames[0]!.amount0).toBe(5n);
    expect(frames[2]!.amount0).toBe(0n);
  });

  it("decodes the call params so the integrity check has something to check", () => {
    const [f] = framesFromTrace(
      traceOf([
        { tokenId: 7n, liquidityDelta: -12345n, fee0: 1n, fee1: 2n, tickLower: -60, tickUpper: 120 },
      ]),
      POOL_MANAGER,
    );
    expect(f).toMatchObject({
      salt: "7",
      ordinal: 0,
      tickLower: -60,
      tickUpper: 120,
      liquidityDelta: -12345n,
      amount0: 1n,
      amount1: 2n,
    });
  });

  it("ignores frames that are not this PoolManager's", () => {
    const trace = traceOf([{ tokenId: 7n, liquidityDelta: 0n, fee0: 9n, fee1: 9n }]);
    expect(framesFromTrace(trace, "0x2222222222222222222222222222222222222222")).toEqual([]);
  });

  it("takes MAGNITUDES — feesAccrued is signed, a collected fee is not", () => {
    const [f] = framesFromTrace(
      traceOf([{ tokenId: 7n, liquidityDelta: 0n, fee0: -5n, fee1: -6n }]),
      POOL_MANAGER,
    );
    expect([f!.amount0, f!.amount1]).toEqual([5n, 6n]);
  });
});

describe("the settlement shapes measured in the Avalanche population", () => {
  const FEE0 = 262354965774593714n;
  const FEE1 = 6708203n;

  it("[0, negative] — 661 txs: collect frame then withdraw frame", () => {
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 137n, liquidityDelta: 0n, fee0: FEE0, fee1: FEE1 },
        { tokenId: 137n, liquidityDelta: -5_000n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [
      { tokenId: 137n, logIndex: 4, liquidityDelta: 0n },
      { tokenId: 137n, logIndex: 9, liquidityDelta: -5_000n },
    ]);

    expect(got).toEqual([
      { logIndex: 4, ordinal: 0, status: "matched", fee0: FEE0, fee1: FEE1 },
      { logIndex: 9, ordinal: 1, status: "matched", fee0: 0n, fee1: 0n },
    ]);
    expectConserved(frames, got, 137n);

    // What the two naive pickers would have produced, so the regression cannot
    // come back unnoticed.
    const lastWins = [...frames].reverse().find((f) => f.salt === "137")!;
    expect(lastWins.amount0).toBe(0n); // the shipped defect: the fee vanishes
    const firstWins = frames.find((f) => f.salt === "137")!;
    expect(firstWins.amount0 * 2n).toBe(FEE0 * 2n); // both events ⇒ double count
  });

  it("[negative] — 380 txs: a lone withdraw frame carrying the fee", () => {
    const frames = framesFromTrace(
      traceOf([{ tokenId: 137n, liquidityDelta: -5_000n, fee0: FEE0, fee1: FEE1 }]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [
      { tokenId: 137n, logIndex: 3, liquidityDelta: -5_000n },
    ]);
    expect(got).toEqual([
      { logIndex: 3, ordinal: 0, status: "matched", fee0: FEE0, fee1: FEE1 },
    ]);
    expectConserved(frames, got, 137n);
  });

  it("[0, positive] — 182 txs: an INCREASE that settles fees", () => {
    /*
     * The shape the removed `feeGrowthChanged` heuristic claimed was safe to
     * skip. 43114_3132 is the counterexample, and 96 fee-bearing positive-delta
     * frames exist in the population.
     */
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 3132n, liquidityDelta: 0n, fee0: FEE0, fee1: FEE1 },
        { tokenId: 3132n, liquidityDelta: 4_200n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [
      { tokenId: 3132n, logIndex: 11, liquidityDelta: 0n },
      { tokenId: 3132n, logIndex: 12, liquidityDelta: 4_200n },
    ]);
    expect(got.map((a) => a.fee0)).toEqual([FEE0, 0n]);
    expectConserved(frames, got, 3132n);
  });

  it("[0, 0] — 35 txs: TWO FRAMES IDENTICAL IN SALT, TICKS AND DELTA", () => {
    /*
     * tx 0x44e8625d81, position 43114_7842. Nothing but the ordinal separates
     * these two, which is the entire reason the pairing is ordinal rather than
     * keyed on (salt, tickLower, tickUpper, liquidityDelta).
     */
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 7842n, liquidityDelta: 0n, fee0: FEE0, fee1: FEE1 },
        { tokenId: 7842n, liquidityDelta: 0n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    // The four-field key really is degenerate here — assert it, so nobody
    // "simplifies" the ordinal away again.
    const byFields = frames.filter(
      (f) => f.salt === "7842" && f.tickLower === TICKS.tickLower && f.liquidityDelta === 0n,
    );
    expect(byFields).toHaveLength(2);

    const got = replayTransaction(frames, [
      { tokenId: 7842n, logIndex: 2, liquidityDelta: 0n },
      { tokenId: 7842n, logIndex: 3, liquidityDelta: 0n },
    ]);
    expect(got).toEqual([
      { logIndex: 2, ordinal: 0, status: "matched", fee0: FEE0, fee1: FEE1 },
      { logIndex: 3, ordinal: 1, status: "matched", fee0: 0n, fee1: 0n },
    ]);
    expectConserved(frames, got, 7842n);
  });

  it("[0] — 5 txs: a lone pure collect", () => {
    const frames = framesFromTrace(
      traceOf([{ tokenId: 1121n, liquidityDelta: 0n, fee0: FEE0, fee1: FEE1 }]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [{ tokenId: 1121n, logIndex: 0, liquidityDelta: 0n }]);
    expect(got[0]).toMatchObject({ ordinal: 0, status: "matched", fee0: FEE0 });
    expectConserved(frames, got, 1121n);
  });

  it("[positive] — 1 tx: a lone increase carrying the fee", () => {
    const frames = framesFromTrace(
      traceOf([{ tokenId: 555n, liquidityDelta: 9_000n, fee0: FEE0, fee1: FEE1 }]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [{ tokenId: 555n, logIndex: 7, liquidityDelta: 9_000n }]);
    expect(got[0]).toMatchObject({ ordinal: 0, status: "matched", fee0: FEE0, fee1: FEE1 });
    expectConserved(frames, got, 555n);
  });
});

describe("the invariant: attributed total === traced total", () => {
  it("holds for a router batching several positions and several settlements", () => {
    /*
     * The general case, interleaved: two positions, one of them settled twice,
     * frames and logs in the same execution order. Per-salt ordinals must not
     * be disturbed by the other salt's frames sitting between them.
     */
    const specs: FrameSpec[] = [
      { tokenId: 100n, liquidityDelta: 0n, fee0: 11n, fee1: 12n },
      { tokenId: 200n, liquidityDelta: 0n, fee0: 21n, fee1: 22n },
      { tokenId: 100n, liquidityDelta: -1n, fee0: 0n, fee1: 0n },
      { tokenId: 200n, liquidityDelta: -2n, fee0: 0n, fee1: 0n },
      { tokenId: 100n, liquidityDelta: 0n, fee0: 31n, fee1: 32n },
    ];
    const frames = framesFromTrace(traceOf(specs), POOL_MANAGER);
    const events: EventSpec[] = specs.map((s, i) => ({
      tokenId: s.tokenId,
      logIndex: i * 3 + 1,
      liquidityDelta: s.liquidityDelta,
    }));
    const got = replayTransaction(frames, events);

    expect(got.every((a) => a.status === "matched")).toBe(true);
    for (const tokenId of [100n, 200n]) {
      expectConserved(
        frames,
        got.filter((_, i) => events[i]!.tokenId === tokenId),
        tokenId,
      );
    }
    // And nothing was attributed twice: every frame used at most once.
    expect(got.map((a) => a.fee0)).toEqual([11n, 21n, 0n, 0n, 31n]);
  });

  it("never attributes one frame to two events, even when the events are identical", () => {
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 7842n, liquidityDelta: 0n, fee0: 1_000n, fee1: 0n },
        { tokenId: 7842n, liquidityDelta: 0n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [
      { tokenId: 7842n, logIndex: 2, liquidityDelta: 0n },
      { tokenId: 7842n, logIndex: 3, liquidityDelta: 0n },
    ]);
    expect(got.map((a) => a.ordinal)).toEqual([0, 1]);
    expect(sum(got.map((a) => a.fee0))).toBe(1_000n);
  });

  it("UNDER-reports rather than double counts when there are more logs than frames", () => {
    // A third same-salt log with only two frames: the extra event pairs with
    // nothing and records zero. The total is still exactly the traced total.
    const frames = framesFromTrace(
      traceOf([
        { tokenId: 7n, liquidityDelta: 0n, fee0: 500n, fee1: 0n },
        { tokenId: 7n, liquidityDelta: -1n, fee0: 0n, fee1: 0n },
      ]),
      POOL_MANAGER,
    );
    const got = replayTransaction(frames, [
      { tokenId: 7n, logIndex: 1, liquidityDelta: 0n },
      { tokenId: 7n, logIndex: 2, liquidityDelta: -1n },
      { tokenId: 7n, logIndex: 3, liquidityDelta: -1n },
    ]);
    expect(got.map((a) => a.status)).toEqual(["matched", "matched", "absent"]);
    expect(sum(got.map((a) => a.fee0))).toBe(500n);
  });
});

describe("saltOrdinal — stateless, and that is the point", () => {
  const key = {
    chainId: CHAIN,
    salt: saltOf(137n),
    logIndex: 10,
    tickLower: -887220n,
    tickUpper: 887220n,
    liquidityDelta: 0n,
  };
  const row = (salt: string, logIndex: number, chainId = CHAIN): PriorModifyRow => ({
    chainId: BigInt(chainId),
    salt,
    logIndex: BigInt(logIndex),
  });

  it("counts only STRICTLY LOWER log indices, so a replay is idempotent", () => {
    // The event's own row is present on a re-processed batch. It must not
    // change its own answer — the same argument as the gas-bearer rule.
    const rows = [row(saltOf(137n), 4), row(saltOf(137n), 10)];
    expect(saltOrdinal(rows, key)).toBe(1);
    expect(saltOrdinal([...rows, row(saltOf(137n), 10)], key)).toBe(1);
  });

  it("ignores other salts, other chains, and later logs", () => {
    const rows = [
      row(saltOf(999n), 1), // another position in the same router batch
      row(saltOf(137n), 2, 1), // same salt, different chain
      row(saltOf(137n), 99), // a later log of the same salt
      row(saltOf(137n), 3), // the only one that counts
    ];
    expect(saltOrdinal(rows, key)).toBe(1);
  });

  it("compares salts case-insensitively", () => {
    expect(saltOrdinal([row(saltOf(137n).toUpperCase().replace("0X", "0x"), 1)], key)).toBe(1);
  });

  it("is 0 when nothing precedes, including on an empty store", () => {
    expect(saltOrdinal([], key)).toBe(0);
    expect(saltOrdinal([row(saltOf(137n), 11)], key)).toBe(0);
  });
});

describe("pickFeeFrame — ordinal pairs, fields only verify", () => {
  const frames = framesFromTrace(
    traceOf([
      { tokenId: 137n, liquidityDelta: 0n, fee0: 7n, fee1: 8n },
      { tokenId: 137n, liquidityDelta: -5n, fee0: 0n, fee1: 0n },
    ]),
    POOL_MANAGER,
  );
  const key = {
    chainId: CHAIN,
    salt: saltOf(137n),
    logIndex: 1,
    tickLower: BigInt(TICKS.tickLower),
    tickUpper: BigInt(TICKS.tickUpper),
    liquidityDelta: 0n,
  };

  it("returns the frame at the ordinal", () => {
    const pick = pickFeeFrame(frames, key, 0);
    expect(pick.status).toBe("matched");
    expect(pick.status === "matched" && pick.frame.amount0).toBe(7n);
  });

  it("is ABSENT past the end, and for a salt with no frames — not an error", () => {
    expect(pickFeeFrame(frames, key, 2).status).toBe("absent");
    expect(pickFeeFrame(frames, { ...key, salt: saltOf(999n) }, 0).status).toBe("absent");
    expect(pickFeeFrame([], key, 0).status).toBe("absent");
  });

  it("is MISMATCHED when the frame at that ordinal describes a different call", () => {
    /*
     * The one way the ordinal can drift: this indexer writes no ModifyLiquidity
     * row for a skipped pool, while the trace still contains that pool's call
     * frame. The handler must then record ZERO and log loudly rather than
     * attribute another position's money.
     */
    expect(pickFeeFrame(frames, { ...key, liquidityDelta: -5n }, 0).status).toBe("mismatched");
    expect(pickFeeFrame(frames, { ...key, tickLower: -60n }, 0).status).toBe("mismatched");
    expect(pickFeeFrame(frames, { ...key, tickUpper: 60n }, 0).status).toBe("mismatched");
  });

  it("accepts an unpadded or upper-case salt — both sides normalise to decimal", () => {
    expect(pickFeeFrame(frames, { ...key, salt: "0x89" }, 0).status).toBe("matched");
    expect(pickFeeFrame(frames, { ...key, salt: "0X89" }, 0).status).toBe("matched");
  });
});

describe("traceGateCanPass — what still must NOT be traced", () => {
  it("a MINT traces nothing: no prior position, so feesAccrued is provably (0,0)", () => {
    /*
     * The conjunct that makes the widened gate affordable. Mints are the bulk of
     * ModifyLiquidity events; if they traced, the cost would be ~100x rather
     * than the measured 1.6x on chain 43114.
     */
    expect(
      traceGateCanPass({ hadPosition: false, storedLiquidity: 0n, liquidityDelta: 1_000_000n }),
    ).toBe(false);
  });

  it("a top-up of a position the store has never seen still traces nothing", () => {
    expect(
      traceGateCanPass({ hadPosition: false, storedLiquidity: 0n, liquidityDelta: 5n }),
    ).toBe(false);
  });

  it("a closed position being re-minted traces nothing", () => {
    expect(
      traceGateCanPass({ hadPosition: true, storedLiquidity: 0n, liquidityDelta: 5n }),
    ).toBe(false);
  });

  it("traces every settlement of a position that HELD liquidity, whatever the delta", () => {
    for (const liquidityDelta of [-5n, 0n, 5n]) {
      expect(
        traceGateCanPass({ hadPosition: true, storedLiquidity: 1n, liquidityDelta }),
      ).toBe(true);
    }
  });

  it("FORCES a trace on a detectable store desync", () => {
    // Removing liquidity from a position with none is impossible on-chain — it
    // reverts — so the stored 0 is proof the store is behind, not proof there
    // are no fees.
    expect(
      traceGateCanPass({ hadPosition: true, storedLiquidity: 0n, liquidityDelta: -1n }),
    ).toBe(true);
    expect(
      traceGateCanPass({ hadPosition: false, storedLiquidity: 0n, liquidityDelta: -1n }),
    ).toBe(true);
  });

  it("FORCES a trace on a PURE COLLECT against a desynced store, not only a withdraw", () => {
    /*
     * The desync clause was `storedLiquidity === 0n && liquidityDelta < 0n`, so
     * it covered withdrawals only. A pure collect (delta == 0) against the same
     * known-bad row fell through to `hadPosition && storedLiquidity > 0n`,
     * failed it, and had its fee recorded as ZERO with no log line of any level.
     *
     * Pure collects are 69.9% of fee-bearing settlements — the same share that
     * made the old `liquidityDelta < 0n` trace gate cover barely a third of the
     * Avalanche damage. And a row clamped to 0 drops out of the fee sweep's
     * candidate filter, so nothing re-reads it from chain: the loss is permanent
     * against an append-only `totalFeesCollected`.
     *
     * A zero-liquidity position can genuinely still hold uncollected fees, so
     * this traces on its own merits rather than merely defensively.
     */
    expect(
      traceGateCanPass({ hadPosition: true, storedLiquidity: 0n, liquidityDelta: 0n }),
    ).toBe(true);
    expect(
      traceGateCanPass({ hadPosition: false, storedLiquidity: 0n, liquidityDelta: 0n }),
    ).toBe(true);
  });

  it("still does NOT trace a mint, which is what keeps the widening honest", () => {
    // The widening is to `<= 0n`, not to "any delta". A mint has no prior
    // position and provably no fees; letting it through would be the
    // over-tracing the gate exists to avoid.
    expect(
      traceGateCanPass({ hadPosition: false, storedLiquidity: 0n, liquidityDelta: 1n }),
    ).toBe(false);
  });

  it("takes no pool price state, so `degenerate` cannot be re-added as a conjunct", () => {
    /*
     * A degenerate pool's TICK MATH is meaningless and the handler still zeroes
     * every tick-derived amount on one. `feesAccrued` is not tick math — it is a
     * return value read from the trace — so a degenerate pool's collected fee is
     * real money and must still be measured.
     */
    expect(traceGateCanPass.length).toBe(1);
    expect(
      // @ts-expect-error — no pool-state argument exists to gate on.
      traceGateCanPass({ hadPosition: true, storedLiquidity: 1n, liquidityDelta: 0n, degenerate: true }),
    ).toBe(true);
  });
});

