/**
 * THE REPLAY TEST — the only one here that can fail on chain truth.
 *
 * Every other fee test in this repo asserts that the code does what the code
 * says. This one takes 18 real Avalanche positions whose COLLECTED FEES THE
 * DEPLOYED INDEXER GOT WRONG, replays their real settlement transactions
 * through the production frame-pairing path, and asserts the attributed totals
 * equal the amounts the chain actually paid out.
 *
 * WHERE THE NUMBERS COME FROM. `expected_collected_token0/1` in
 * `deployed-wrong-collected-fees.csv` — the audit that diagnosed this defect,
 * in which all 1,167 affected positions and all ~2,062 of their settlement
 * transactions were traced and decoded against the chain, with 0 left
 * unexplained. `deployed_collected_token0/1` in the same file is what the
 * deployment at indexer.hyperindex.xyz/bd820cf actually served. The fixture
 * carries both, so this file asserts the fix AND reproduces the defect.
 *
 * THE FIXTURE is real `debug_traceTransaction`/callTracer output and real
 * receipt logs from an Avalanche archive node, pruned by
 * `scripts/build-fee-replay-fixture.mjs`: every PoolManager.modifyLiquidity
 * frame is kept VERBATIM, along with the shape of the call tree around it, and
 * everything else is stripped to a selector. No network at test time.
 *
 * WHAT IT PROVES, in order:
 *
 *  1. LOG ORDER === FRAME ORDER. The k-th same-salt ModifyLiquidity log is the
 *     k-th same-salt `modifyLiquidity` call frame. The whole ordinal pairing
 *     rests on this, and it is asserted here against real data rather than
 *     assumed.
 *  2. The new pairing reproduces the chain's collected fees exactly.
 *  3. The two pickers that do not work — the shipped LAST-wins and the tempting
 *     FIRST-wins — are shown failing on the same data, so neither can be
 *     reintroduced as a "simplification".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { decodeEventLog, parseUnits } from "viem";

import { framesFromTrace, type ModifyFrame } from "./effects/feesAccrued";
import { pickFeeFrame, saltOrdinal, saltToDecimal, type PriorModifyRow } from "./utils/feeFrames";
import { positionManagerFor } from "./utils/v4Addresses";

const MODIFY_LIQUIDITY_EVENT = [
  {
    type: "event",
    name: "ModifyLiquidity",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidityDelta", type: "int256", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const;

interface Fixture {
  readonly chainId: number;
  readonly poolManager: string;
  readonly positions: ReadonlyArray<{
    readonly positionId: string;
    readonly tokenId: string;
    readonly case: "MISSED_ALL" | "PARTIAL";
    readonly token0Symbol: string;
    readonly token1Symbol: string;
    readonly decimals0: number;
    readonly decimals1: number;
    readonly deployed0: string;
    readonly deployed1: string;
    readonly expected0: string;
    readonly expected1: string;
    readonly txHashes: readonly string[];
  }>;
  readonly transactions: Record<
    string,
    {
      readonly trace: unknown;
      readonly logs: ReadonlyArray<{
        readonly logIndex: number;
        readonly topics: readonly string[];
        readonly data: string;
      }>;
    }
  >;
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/avalanche-settlement-traces.json", import.meta.url)),
    "utf8",
  ),
);

const POSITION_MANAGER = positionManagerFor(FIXTURE.chainId)!;

interface DecodedLog {
  readonly logIndex: number;
  readonly sender: string;
  readonly tickLower: bigint;
  readonly tickUpper: bigint;
  readonly liquidityDelta: bigint;
  /** The raw bytes32, exactly as `event.params.salt` reaches the handler. */
  readonly salt: string;
}

/** The PoolManager's ModifyLiquidity logs of one transaction, in log order. */
function logsOf(txHash: string): DecodedLog[] {
  const tx = FIXTURE.transactions[txHash]!;
  return tx.logs
    .map((l) => {
      const { args } = decodeEventLog({
        abi: MODIFY_LIQUIDITY_EVENT,
        topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
        data: l.data as `0x${string}`,
      });
      return {
        logIndex: l.logIndex,
        sender: args.sender,
        tickLower: BigInt(args.tickLower),
        tickUpper: BigInt(args.tickUpper),
        liquidityDelta: args.liquidityDelta,
        salt: args.salt,
      };
    })
    .sort((a, b) => a.logIndex - b.logIndex);
}

const framesOf = (txHash: string): ModifyFrame[] =>
  framesFromTrace(FIXTURE.transactions[txHash]!.trace as never, FIXTURE.poolManager);

const allTxHashes = Object.keys(FIXTURE.transactions);

describe("the invariant the ordinal pairing rests on, against real Avalanche traces", () => {
  it("emits exactly one ModifyLiquidity LOG per modifyLiquidity call FRAME", () => {
    for (const tx of allTxHashes) {
      expect(logsOf(tx).length, tx).toBe(framesOf(tx).length);
    }
  });

  it("LOG order equals call-frame order, matched on (tickLower, tickUpper, liquidityDelta, salt)", () => {
    /*
     * This is the property the entire fix depends on: because the sequences
     * agree, the k-th same-salt log can be paired with the k-th same-salt
     * frame without ever fetching a receipt at index time. The original audit
     * checked it on all 2,062 Avalanche settlement transactions, 2062/2062 with
     * zero exceptions; this asserts it on the sample carried here.
     */
    let checked = 0;
    for (const tx of allTxHashes) {
      const logs = logsOf(tx);
      const frames = framesOf(tx);
      logs.forEach((l, i) => {
        const f = frames[i]!;
        expect([f.salt, BigInt(f.tickLower), BigInt(f.tickUpper), f.liquidityDelta], `${tx} #${i}`)
          .toEqual([saltToDecimal(l.salt), l.tickLower, l.tickUpper, l.liquidityDelta]);
        checked++;
      });
    }
    expect(checked).toBeGreaterThanOrEqual(50);
  });
});

/**
 * Replay ONE transaction exactly as the handler does: events in log order, each
 * writing its ModifyLiquidity row before pairing, the ordinal counted over the
 * rows already written for that salt.
 *
 * NOTE WHICH LOGS COUNT FOR WHAT. The ordinal counts EVERY same-salt log,
 * whatever the caller, because the handler writes a ModifyLiquidity entity for
 * every one of them and the trace's frame list is likewise every call. Only
 * PositionManager logs are ATTRIBUTED, because only there is `salt` an NFT
 * tokenId.
 */
function attribute(txHash: string, tokenId: string): { amount0: bigint; amount1: bigint } {
  const frames = framesOf(txHash);
  const rows: PriorModifyRow[] = [];
  let amount0 = 0n;
  let amount1 = 0n;

  for (const log of logsOf(txHash)) {
    const key = {
      chainId: FIXTURE.chainId,
      salt: log.salt,
      logIndex: log.logIndex,
      tickLower: log.tickLower,
      tickUpper: log.tickUpper,
      liquidityDelta: log.liquidityDelta,
    };
    rows.push({ chainId: BigInt(FIXTURE.chainId), salt: log.salt, logIndex: BigInt(log.logIndex) });

    if (log.sender.toLowerCase() !== POSITION_MANAGER) continue;
    if (saltToDecimal(log.salt) !== tokenId) continue;

    const pick = pickFeeFrame(frames, key, saltOrdinal(rows, key));
    expect(pick.status, `${txHash} #${log.logIndex}`).toBe("matched");
    if (pick.status === "matched") {
      amount0 += pick.frame.amount0;
      amount1 += pick.frame.amount1;
    }
  }
  return { amount0, amount1 };
}

/**
 * The CSV carries ~15 significant digits, so an exact BigInt equality would
 * fail on its rounding rather than on the code — the audit noted the same three
 * "apparent misses". A 1e-12 RELATIVE band is far tighter than any of the
 * defects here (which are whole amounts, not last digits) and far looser than
 * the CSV's own precision.
 */
function expectClose(actual: bigint, expected: string, decimals: number, label: string) {
  const want = parseUnits(expected as `${number}`, decimals);
  const diff = actual > want ? actual - want : want - actual;
  const tolerance = want / 1_000_000_000_000n;
  expect(diff <= (tolerance < 0n ? -tolerance : tolerance), `${label}: got ${actual}, want ${want}`).toBe(true);
}

describe("collected fees replayed from real traces equal what the chain paid", () => {
  for (const p of FIXTURE.positions) {
    it(`${p.positionId} (${p.case}, ${p.token0Symbol}/${p.token1Symbol}, ${p.txHashes.length} settlement tx)`, () => {
      let amount0 = 0n;
      let amount1 = 0n;
      for (const tx of p.txHashes) {
        const got = attribute(tx, p.tokenId);
        amount0 += got.amount0;
        amount1 += got.amount1;
      }
      expectClose(amount0, p.expected0, p.decimals0, `${p.positionId}.token0`);
      expectClose(amount1, p.expected1, p.decimals1, `${p.positionId}.token1`);
    });
  }

  it("covers both audit cases and enough positions to be worth the name", () => {
    expect(FIXTURE.positions.length).toBeGreaterThanOrEqual(15);
    expect(FIXTURE.positions.some((p) => p.case === "MISSED_ALL")).toBe(true);
    expect(FIXTURE.positions.some((p) => p.case === "PARTIAL")).toBe(true);
  });

  it("carries every settlement SHAPE the population has, in real traces", () => {
    /*
     * The shapes are the per-(transaction, salt) sequences of liquidity deltas.
     * `feeFramePairing.test.ts` exercises each one synthetically; this asserts
     * the replay is not quietly narrower than that — in particular that the two
     * hard ones are present in REAL data: `0,0` (two frames identical in salt,
     * ticks and delta, separable only by ordinal) and `0,+` (a fee-bearing
     * INCREASE, which the removed `feeGrowthChanged` heuristic claimed was safe
     * to skip).
     */
    const shapes = new Map<string, number>();
    for (const tx of allTxHashes) {
      const bySalt = new Map<string, ModifyFrame[]>();
      for (const f of framesOf(tx)) bySalt.set(f.salt, [...(bySalt.get(f.salt) ?? []), f]);
      for (const group of bySalt.values()) {
        const shape = group
          .map((f) => (f.liquidityDelta === 0n ? "0" : f.liquidityDelta < 0n ? "-" : "+"))
          .join(",");
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      }
    }
    for (const shape of ["0,-", "-", "0,+", "0,0", "0", "+"]) {
      expect(shapes.get(shape) ?? 0, `shape ${shape}`).toBeGreaterThan(0);
    }
  });
});

describe("the pickers that do not work, on the same real data", () => {
  /** What the handler used to do: last same-salt frame in the transaction. */
  const lastWins = (frames: readonly ModifyFrame[], tokenId: string) =>
    [...frames].reverse().find((f) => f.salt === tokenId);
  /** The tempting one-character "fix". */
  const firstWins = (frames: readonly ModifyFrame[], tokenId: string) =>
    frames.find((f) => f.salt === tokenId);

  function totals(p: Fixture["positions"][number], pick: typeof lastWins) {
    let a0 = 0n;
    let a1 = 0n;
    for (const tx of p.txHashes) {
      const frames = framesOf(tx);
      // One attribution per PositionManager log for this salt, which is what the
      // widened gate produces — that is precisely why first-wins double counts.
      const n = logsOf(tx).filter(
        (l) => l.sender.toLowerCase() === POSITION_MANAGER && saltToDecimal(l.salt) === p.tokenId,
      ).length;
      const f = pick(frames, p.tokenId);
      if (f) {
        a0 += f.amount0 * BigInt(n);
        a1 += f.amount1 * BigInt(n);
      }
    }
    return { a0, a1 };
  }

  it("every position here really was under-reported by the deployment", () => {
    // Sanity on the fixture itself before anything is concluded from it: the
    // audit's `deployed_collected_*` is below its `expected_collected_*` for all
    // 18, in at least one token. This is the money that went missing.
    const under = FIXTURE.positions.filter(
      (p) => Number(p.deployed0) < Number(p.expected0) || Number(p.deployed1) < Number(p.expected1),
    );
    expect(under.length).toBe(FIXTURE.positions.length);
  });

  it("LAST-wins — the shipped defect — lands on a ZERO frame in EVERY same-salt pair here", () => {
    /*
     * THE MECHANISM, isolated. For each (transaction, salt) group with more than
     * one frame, the group's fees are non-zero and the LAST frame is (0, 0) — so
     * `[...fees].reverse().find(salt)` returns zero and the whole settlement is
     * recorded as no fee at all. 17 of 17 groups in this fixture, matching the
     * audit's 101/101 across the full population.
     */
    let pairs = 0;
    let lastFrameIsZero = 0;
    for (const tx of allTxHashes) {
      const bySalt = new Map<string, ModifyFrame[]>();
      for (const f of framesOf(tx)) bySalt.set(f.salt, [...(bySalt.get(f.salt) ?? []), f]);
      for (const [salt, group] of bySalt) {
        if (group.length < 2) continue;
        const total = group.reduce((a, f) => a + f.amount0 + f.amount1, 0n);
        if (total === 0n) continue;
        pairs++;
        const last = lastWins(group, salt)!;
        if (last.amount0 === 0n && last.amount1 === 0n) lastFrameIsZero++;
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(15);
    expect(lastFrameIsZero).toBe(pairs);
  });

  it("FIRST-wins DOUBLE COUNTS once both same-salt events trace", () => {
    const doubled = FIXTURE.positions.filter((p) => {
      const { a0, a1 } = totals(p, firstWins);
      const want0 = parseUnits(p.expected0 as `${number}`, p.decimals0);
      const want1 = parseUnits(p.expected1 as `${number}`, p.decimals1);
      return a0 > want0 || a1 > want1;
    });
    // Not every position has a same-salt pair, but the ones that do overstate —
    // which is the whole reason the pairing had to be ordinal rather than a
    // flipped `.reverse()`.
    expect(doubled.length).toBeGreaterThan(0);
  });
});
