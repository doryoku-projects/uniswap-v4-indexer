/**
 * UNCOLLECTED FEES: the contract's modular math, and the sweep that applies it
 * to EVERY candidate — in range or out.
 *
 * Two defects, one shape. `calculateUncollectedFees` clamped a negative raw
 * delta to 0, and the sweep wrote 0/0 for every out-of-range position without
 * reading it. Both rest on the same false belief — that an out-of-range
 * position has nothing to collect — and both produced a PLAUSIBLE zero rather
 * than an error. The contract computes `toUint256(inside − last) × L / 2^128`
 * with unchecked uint256 arithmetic, and for an out-of-range position the raw
 * difference routinely looks negative while the claimable amount is real
 * (mainnet tokenIds 10014 and 100022 were verified that way on chain; the Ponder
 * port's identical fix matched on-chain StateView math on 1,000/1,000 + 144/144
 * positions).
 *
 * A third rule rides along: the sweep moves `updatedAtBlock` — the backend's
 * change feed — ONLY when it heals liquidity / isActive from chain, never on a
 * plain fee or price refresh.
 *
 * The sweep is driven through `sweepUncollectedFees` with a mock context, the
 * idiom `feeGate.test.ts` uses: the handler file itself cannot be imported
 * (top-level `await` for chain heads, `indexer.onBlock` registration).
 */

import { describe, it, expect, vi } from "vitest";
import { BigDecimal, type EvmOnBlockContext, type Pool, type Position, type Token } from "envio";

import { calculateUncollectedFees, Q128, toUint256 } from "./utils/fees";
import { sweepUncollectedFees, SWEEP_BATCH_SIZE, type SweepArgs } from "./utils/feeSweep";
import { getPositionFeeGrowthBatch } from "./effects/positionState";
import { currentAmounts, newPosition } from "./utils/positions";
import { TickMath } from "./utils/liquidityMath/tickMath";

const TWO_256 = 1n << 256n;

// ─── the math ────────────────────────────────────────────────────────────────

describe("calculateUncollectedFees — the contract's modular formula", () => {
  it("is unchanged for an ordinary in-range, positive delta", () => {
    const L = 3n * 10n ** 18n;
    const u = calculateUncollectedFees(L, 7n * Q128, 11n * Q128, 2n * Q128, 1n * Q128);
    expect(u).toEqual({ amount0: 5n * L, amount1: 10n * L });
  });

  it("pays an OUT-OF-RANGE position whose raw delta looks negative — the leg the clamp zeroed", () => {
    /*
     * The ordinary out-of-range reading. The checkpoint sits near 2^256 (its
     * inside value was composed while out of range and wrapped), growth since
     * then carried `inside` past zero, so `inside − last` is negative as a plain
     * integer and 25·Q128 + 12345 mod 2^256. The clamp returned 0 here.
     */
    const L = 10n ** 18n + 7n;
    const last0 = TWO_256 - 20n * Q128;
    const fg0 = 5n * Q128 + 12345n;
    expect(fg0 - last0 < 0n).toBe(true);

    const u = calculateUncollectedFees(L, fg0, 0n, last0, 0n);
    // floor((25·Q128 + 12345) · L / Q128), worked by hand: 25·L + floor(12345·L/2^128).
    expect(u.amount0).toBe(25_000_000_000_000_000_175n);
    expect(u.amount1).toBe(0n);
  });

  it("wraps across 2^256 exactly: last = 2^256 − 1, inside = 3 is a growth of 4", () => {
    expect(calculateUncollectedFees(Q128, 3n, 0n, TWO_256 - 1n, 0n).amount0).toBe(4n);
  });

  it("computes BOTH legs independently when both look negative (the clamp returned 0/0)", () => {
    const L = 10n ** 18n + 7n;
    const u = calculateUncollectedFees(
      L,
      5n * Q128 + 12345n,
      1n << 127n,
      TWO_256 - 20n * Q128,
      TWO_256 - 1n,
    );
    expect(u.amount0).toBe(25_000_000_000_000_000_175n);
    // (2^127 + 1) · L / 2^128 = floor(L/2 + L/2^128) = floor(500000000000000003.5 + ε)
    expect(u.amount1).toBe(500_000_000_000_000_003n);
  });

  it("floors like FullMath.mulDiv", () => {
    // 1 unit of growth per 2^128 against L = 2^128 − 1 is 0.99… → 0.
    expect(calculateUncollectedFees(Q128 - 1n, 1n, 1n, 0n, 0n)).toEqual({ amount0: 0n, amount1: 0n });
    expect(calculateUncollectedFees(Q128 + 1n, 1n, 2n, 0n, 0n)).toEqual({ amount0: 1n, amount1: 2n });
  });

  it("is 0/0 for zero or negative liquidity, whatever the growth", () => {
    for (const L of [0n, -1n, -(10n ** 30n)]) {
      expect(calculateUncollectedFees(L, 5n * Q128, 5n * Q128, TWO_256 - Q128, 0n)).toEqual({
        amount0: 0n,
        amount1: 0n,
      });
    }
  });

  it("has NO magnitude cap: a huge legitimate fee is returned as is", () => {
    // A cheap, high-supply token: 10^40 raw units of fee is a real number.
    const L = 10n ** 30n;
    const growth = 10n ** 10n * Q128;
    expect(calculateUncollectedFees(L, growth, 0n, 0n, 0n).amount0).toBe(10n ** 40n);
  });

  it("toUint256 is exact mod 2^256 for any bigint, not just one wrap", () => {
    expect(toUint256(-1n)).toBe(TWO_256 - 1n);
    expect(toUint256(-TWO_256 - 5n)).toBe(TWO_256 - 5n);
    expect(toUint256(TWO_256 + 9n)).toBe(9n);
    expect(toUint256(42n)).toBe(42n);
  });
});

describe("the modular formula reproduces what a position actually earned", () => {
  /*
   * A small model of v4's own bookkeeping — `Pool.getFeeGrowthInside` and tick
   * `feeGrowthOutside` flips on crossing, all unchecked mod 2^256 — driving one
   * position through: minted OUT of range, swept into range, earning there,
   * swept back out. The true accrual is known independently (growth of
   * `feeGrowthGlobal` while it was in range, times L), so the test checks the
   * formula against what the position EARNED, not against itself.
   */
  const U = (n: bigint) => BigInt.asUintN(256, n);
  const inside = (global: bigint, outL: bigint, outU: bigint, tick: number, tl: number, tu: number) =>
    tick < tl ? U(outL - outU) : tick >= tu ? U(outU - outL) : U(global - outL - outU);

  it("an out-of-range position with fees earned in range is paid them, to the unit", () => {
    const TL = 0;
    const TU = 100;
    const L = 123_456_789_012_345_678_901n;

    // Upper tick initialised by another LP while price sat above it.
    let global = 10n * Q128;
    let outU = global;
    // Our mint, price still above the range (tick 150): the lower tick is
    // initialised now. inside = outU − outL = −20·Q128, i.e. it wraps.
    global = 30n * Q128;
    const outL = global;
    let tick = 150;
    const last = inside(global, outL, outU, tick, TL, TU);
    expect(last).toBe(TWO_256 - 20n * Q128);

    // Price falls into range, crossing the upper tick: outside flips.
    outU = U(global - outU);
    tick = 50;
    // Swaps while in range — the only growth this position earns.
    const earnedGrowth = 25n * Q128 + 987_654_321n;
    global += earnedGrowth;
    // Price rises back out, crossing the upper tick again.
    outU = U(global - outU);
    tick = 150;
    // More swaps out of range: global grows, the position earns nothing.
    global += 4n * Q128;

    const now = inside(global, outL, outU, tick, TL, TU);
    // Out of range, and the raw difference is negative — the clamp's zero.
    expect(tick >= TU).toBe(true);
    expect(now - last < 0n).toBe(true);

    const u = calculateUncollectedFees(L, now, 0n, last, 0n);
    expect(u.amount0).toBe((earnedGrowth * L) / Q128);
    expect(u.amount0 > 0n).toBe(true);
  });
});

// ─── the sweep ───────────────────────────────────────────────────────────────

const CHAIN = 1;
const BLOCK = 25_000_000n;
const INTERVAL = 224n;
const SWEPT_AT = 1_790_000_000n;
const POOL_ID = "0x" + "c3".repeat(32);
const TOKEN0 = `${CHAIN}_0x0000000000000000000000000000000000000000`;
const TOKEN1 = `${CHAIN}_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`;
const MID_SQRT = 79228162514264337593543950336n; // tick 0, price 1.0
const ADDRESSES = {
  stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};
const ARGS: SweepArgs = {
  chainId: CHAIN,
  blockNumber: BLOCK,
  interval: INTERVAL,
  sweptAt: SWEPT_AT,
  addresses: ADDRESSES,
};

const ORIGINAL_BLOCK = 24_000_000n;
const ORIGINAL_TS = 1_780_000_000n;

function pos(tokenId: bigint, over: Partial<Position> = {}): Position {
  return {
    ...newPosition({
      id: `${CHAIN}_${tokenId}`,
      chainId: BigInt(CHAIN),
      tokenId,
      owner: "0xowner",
      origin: "0xorigin",
      timestamp: ORIGINAL_TS,
      blockNumber: ORIGINAL_BLOCK,
    }),
    poolId: POOL_ID,
    tickLower: -60n,
    tickUpper: 60n,
    liquidity: 10n ** 18n,
    isActive: true,
    feesUpdatedAtBlock: 1n,
    ...over,
  } as Position;
}

function pool(over: Partial<Pool> = {}): Pool {
  return { id: `${CHAIN}_${POOL_ID}`, token0: TOKEN0, token1: TOKEN1, tick: 0n, sqrtPrice: MID_SQRT, ...over } as Pool;
}

const TOKENS: Record<string, Token> = {
  [TOKEN0]: { id: TOKEN0, decimals: 18n } as Token,
  [TOKEN1]: { id: TOKEN1, decimals: 6n } as Token,
};

type State = {
  tokenId: bigint;
  ok: boolean;
  feeGrowthInside0X128: bigint;
  feeGrowthInside1X128: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  liquidity: bigint;
};

type BatchInput = {
  blockNumber: bigint;
  positions: { tokenId: bigint; poolId: string; tickLower: number; tickUpper: number }[];
};

/**
 * The context the sweep touches, and nothing more. `getWhere` honours the two
 * filters the sweep sends, so the stale-set query is exercised for real.
 */
function harness(opts: {
  positions: Position[];
  pools?: Record<string, Pool>;
  states: (input: BatchInput) => State[];
}) {
  const writes: Position[] = [];
  const effect = vi.fn(async (fx: unknown, input: BatchInput) => {
    expect(fx).toBe(getPositionFeeGrowthBatch);
    return opts.states(input);
  });
  const pools = opts.pools ?? { [`${CHAIN}_${POOL_ID}`]: pool() };
  const context = {
    Position: {
      getWhere: async (f: { chainId: { _eq: bigint }; feesUpdatedAtBlock: { _lte: bigint } }) =>
        opts.positions.filter(
          (p) => p.chainId === f.chainId._eq && p.feesUpdatedAtBlock <= f.feesUpdatedAtBlock._lte,
        ),
      set: (row: Position) => writes.push(row),
    },
    Pool: { get: async (id: string) => pools[id] },
    Token: { get: async (id: string) => TOKENS[id] },
    effect,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as EvmOnBlockContext;
  const written = (tokenId: bigint) => {
    const rows = writes.filter((w) => w.tokenId === tokenId);
    expect(rows.length, `writes for ${tokenId}`).toBeLessThanOrEqual(1);
    return rows[0];
  };
  return { context, writes, effect, written };
}

/** A successful read whose fee growth is `growth0/1 · Q128` past the checkpoint. */
const okState = (tokenId: bigint, liquidity: bigint, over: Partial<State> = {}): State => ({
  tokenId,
  ok: true,
  feeGrowthInside0X128: 3n * Q128,
  feeGrowthInside1X128: 4n * Q128,
  feeGrowthInside0LastX128: 1n * Q128,
  feeGrowthInside1LastX128: 1n * Q128,
  liquidity,
  ...over,
});

describe("sweepUncollectedFees — every candidate is read, out of range included", () => {
  it("reads an OUT-OF-RANGE position and writes its real fees and refreshed amounts", async () => {
    const L = 10n ** 18n + 7n;
    const inRange = pos(1n, { liquidity: L });
    // Ticks 600..1200 with the pool at tick 0: below the range, all token0.
    // Its stored amounts are stale zeros — the zeroed path never refreshed them.
    const outOfRange = pos(2n, { liquidity: L, tickLower: 600n, tickUpper: 1200n });

    const { context, effect, written } = harness({
      positions: [inRange, outOfRange],
      states: (input) =>
        input.positions.map((p) =>
          p.tokenId === 2n
            ? // Both raw deltas negative — the clamp's 0/0.
              okState(2n, L, {
                feeGrowthInside0X128: 5n * Q128 + 12345n,
                feeGrowthInside0LastX128: TWO_256 - 20n * Q128,
                feeGrowthInside1X128: 1n << 127n,
                feeGrowthInside1LastX128: TWO_256 - 1n,
              })
            : okState(p.tokenId, L),
        ),
    });

    const summary = await sweepUncollectedFees(context, ARGS);

    // ONE multicall, and it carries the out-of-range position.
    expect(effect).toHaveBeenCalledTimes(1);
    const input = effect.mock.calls[0]![1];
    expect(input.blockNumber).toBe(BLOCK);
    expect(input.positions.map((p) => p.tokenId)).toEqual([1n, 2n]);
    expect(input.positions[1]).toEqual({ tokenId: 2n, poolId: POOL_ID, tickLower: 600, tickUpper: 1200 });

    const row = written(2n)!;
    expect(row.totalFeesUncollected0.toString()).toBe("25.000000000000000175");
    expect(row.totalFeesUncollected1.toString()).toBe("500000000000.000003");
    // Amounts refreshed at the pool's price: below range ⇒ token0 only.
    const want = currentAmounts({
      tickLower: 600n,
      tickUpper: 1200n,
      liquidity: L,
      pool: { tick: 0n, sqrtPriceX96: MID_SQRT },
      decimals0: 18n,
      decimals1: 6n,
    });
    expect(row.amount0.toString()).toBe(want.amount0.toString());
    expect(row.amount0.gt(new BigDecimal(0))).toBe(true);
    expect(row.amount1.toString()).toBe("0");
    expect(row.feesUpdatedAtBlock).toBe(BLOCK);
    expect(row.feesUpdatedAtTimestamp).toBe(SWEPT_AT);

    // The in-range one is valued exactly as before the change: 2·L of token0.
    expect(written(1n)!.totalFeesUncollected0.toString()).toBe("2.000000000000000014");

    expect(summary).toEqual({ candidates: 2, read: 2, outOfRange: 1, failed: 0, healed: 0, skipped: 0 });
  });

  it("values fees against the CONTRACT's checkpoint, never the row's stored baseline", async () => {
    /*
     * The caller contract of the modular math. The row's feeGrowthInside*LastX128
     * is a POOL-level end-of-block read stamped by modifyLiquidity-handler; diffing
     * against it mod 2^256 could invent a ~2^256 fee. Here it is set to a value
     * that would do exactly that, and must be ignored — then overwritten with the
     * checkpoint.
     */
    const L = 10n ** 18n;
    const p = pos(3n, { liquidity: L, feeGrowthInside0LastX128: 9n * Q128, feeGrowthInside1LastX128: 9n * Q128 });
    const { context, written } = harness({ positions: [p], states: () => [okState(3n, L)] });

    await sweepUncollectedFees(context, ARGS);

    const row = written(3n)!;
    expect(row.totalFeesUncollected0.toString()).toBe("2");
    expect(row.totalFeesUncollected1.toString()).toBe("3000000000000");
    expect(row.feeGrowthInside0LastX128).toBe(1n * Q128);
    expect(row.feeGrowthInside1LastX128).toBe(1n * Q128);
  });

  it("keeps the stored amounts on a degenerate pool, but still writes the fees", async () => {
    const L = 10n ** 18n;
    const stale = { amount0: new BigDecimal("1.5"), amount1: new BigDecimal("2.5") };
    const p = pos(4n, { liquidity: L, ...stale });
    const { context, written } = harness({
      positions: [p],
      pools: { [`${CHAIN}_${POOL_ID}`]: pool({ tick: TickMath.MIN_TICK, sqrtPrice: TickMath.MIN_SQRT_RATIO }) },
      states: () => [okState(4n, L)],
    });

    const summary = await sweepUncollectedFees(context, ARGS);

    const row = written(4n)!;
    expect(row.amount0.toString()).toBe("1.5");
    expect(row.amount1.toString()).toBe("2.5");
    expect(row.totalFeesUncollected0.toString()).toBe("2");
    // Degenerate at MIN_TICK is also out of range for -60..60.
    expect(summary.outOfRange).toBe(1);
  });

  it("a failed read stamps ONLY the fee watermark, in range or out", async () => {
    const prior = { totalFeesUncollected0: new BigDecimal("7"), totalFeesUncollected1: new BigDecimal("8") };
    const a = pos(5n, prior);
    const b = pos(6n, { ...prior, tickLower: 600n, tickUpper: 1200n });
    const { context, written } = harness({
      positions: [a, b],
      states: (input) => input.positions.map((p) => ({ ...okState(p.tokenId, 0n), ok: false })),
    });

    const summary = await sweepUncollectedFees(context, ARGS);

    for (const [before, id] of [[a, 5n], [b, 6n]] as const) {
      const row = written(id)!;
      expect(row).toEqual({ ...before, feesUpdatedAtBlock: BLOCK, feesUpdatedAtTimestamp: SWEPT_AT });
    }
    expect(summary).toEqual({ candidates: 2, read: 0, outOfRange: 0, failed: 2, healed: 0, skipped: 0 });
  });

  it("a position missing from the batch result counts as a failed read", async () => {
    const { context, written } = harness({ positions: [pos(7n)], states: () => [] });
    const summary = await sweepUncollectedFees(context, ARGS);
    expect(written(7n)!.feesUpdatedAtBlock).toBe(BLOCK);
    expect(summary.failed).toBe(1);
  });

  it("skips a position whose pool or tokens are missing — no read, no write", async () => {
    const orphan = pos(8n, { poolId: "0x" + "dd".repeat(32) });
    const { context, writes, effect } = harness({ positions: [orphan], states: () => [] });
    const summary = await sweepUncollectedFees(context, ARGS);
    expect(effect).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(summary).toEqual({ candidates: 1, read: 0, outOfRange: 0, failed: 0, healed: 0, skipped: 1 });
  });

  it("selects only stale, active, pooled candidates, oldest fee read first, capped", async () => {
    const cutoff = BLOCK - INTERVAL;
    const many = Array.from({ length: SWEEP_BATCH_SIZE + 5 }, (_, i) =>
      pos(1000n + BigInt(i), { feesUpdatedAtBlock: BigInt(SWEEP_BATCH_SIZE + 5 - i) }),
    );
    const excluded = [
      pos(1n, { isActive: false, liquidity: 0n }),
      pos(2n, { liquidity: 0n }),
      pos(3n, { poolId: "" }),
      pos(4n, { feesUpdatedAtBlock: cutoff + 1n }), // refreshed this cycle
    ];
    const { context, effect } = harness({
      positions: [...excluded, ...many],
      states: (input) => input.positions.map((p) => okState(p.tokenId, 10n ** 18n)),
    });

    const summary = await sweepUncollectedFees(context, ARGS);

    const read = effect.mock.calls[0]![1].positions.map((p) => p.tokenId);
    expect(read).toHaveLength(SWEEP_BATCH_SIZE);
    for (const id of [1n, 2n, 3n, 4n]) expect(read).not.toContain(id);
    // The five with the NEWEST watermark wait for the next firing.
    for (let i = 0; i < 5; i++) expect(read).not.toContain(1000n + BigInt(i));
    expect(summary.candidates).toBe(SWEEP_BATCH_SIZE);
  });

  it("returns early with nothing to do", async () => {
    const { context, effect, writes } = harness({ positions: [], states: () => [] });
    expect(await sweepUncollectedFees(context, ARGS)).toEqual({
      candidates: 0,
      read: 0,
      outOfRange: 0,
      failed: 0,
      healed: 0,
      skipped: 0,
    });
    expect(effect).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("sweepUncollectedFees — updatedAtBlock moves on a heal and on nothing else", () => {
  it("a plain fee + price refresh leaves updatedAtBlock/updatedAtTimestamp alone", async () => {
    const L = 10n ** 18n;
    // Stale amounts and stale fees, so the write genuinely changes values.
    const p = pos(10n, { liquidity: L, amount0: new BigDecimal("0"), amount1: new BigDecimal("0") });
    const { context, written } = harness({ positions: [p], states: () => [okState(10n, L)] });

    const summary = await sweepUncollectedFees(context, ARGS);

    const row = written(10n)!;
    expect(row.totalFeesUncollected0.toString()).toBe("2");
    expect(row.amount0.gt(new BigDecimal(0))).toBe(true);
    expect(row.updatedAtBlock).toBe(ORIGINAL_BLOCK);
    expect(row.updatedAtTimestamp).toBe(ORIGINAL_TS);
    expect(summary.healed).toBe(0);
  });

  it("an out-of-range refresh does not move it either", async () => {
    const L = 10n ** 18n;
    const p = pos(11n, { liquidity: L, tickLower: 600n, tickUpper: 1200n });
    const { context, written } = harness({ positions: [p], states: () => [okState(11n, L)] });
    await sweepUncollectedFees(context, ARGS);
    expect(written(11n)!.updatedAtBlock).toBe(ORIGINAL_BLOCK);
  });

  it("healed liquidity moves updatedAtBlock to the sweep block (a missed event)", async () => {
    const stored = 10n ** 18n;
    const onChain = 3n * 10n ** 18n;
    const p = pos(12n, { liquidity: stored });
    const { context, written } = harness({ positions: [p], states: () => [okState(12n, onChain)] });

    const summary = await sweepUncollectedFees(context, ARGS);

    const row = written(12n)!;
    expect(row.liquidity).toBe(onChain);
    expect(row.isActive).toBe(true);
    expect(row.updatedAtBlock).toBe(BLOCK);
    expect(row.updatedAtTimestamp).toBe(SWEPT_AT);
    // Fee and amounts are computed against the HEALED liquidity.
    expect(row.totalFeesUncollected0.toString()).toBe("6");
    expect(summary).toMatchObject({ read: 1, healed: 1 });
  });

  it("a close the running sum never saw: isActive flips, closedAt stamped, updatedAtBlock moves", async () => {
    const p = pos(13n, { liquidity: 10n ** 18n });
    const { context, written } = harness({ positions: [p], states: () => [okState(13n, 0n)] });

    const summary = await sweepUncollectedFees(context, ARGS);

    const row = written(13n)!;
    expect(row.liquidity).toBe(0n);
    expect(row.isActive).toBe(false);
    expect(row.closedAtTimestamp).toBe(SWEPT_AT);
    expect(row.updatedAtBlock).toBe(BLOCK);
    // No liquidity on chain ⇒ nothing accrues and nothing is owed (v4 settles
    // fees on every modifyLiquidity, so a 0-liquidity position holds none).
    expect(row.totalFeesUncollected0.toString()).toBe("0");
    expect(row.amount0.toString()).toBe("0");
    expect(summary.healed).toBe(1);
  });

  it("an out-of-range position heals too — the old sweep never read it, so never healed it", async () => {
    const p = pos(14n, { liquidity: 10n ** 18n, tickLower: 600n, tickUpper: 1200n });
    const { context, written } = harness({ positions: [p], states: () => [okState(14n, 2n * 10n ** 18n)] });
    const summary = await sweepUncollectedFees(context, ARGS);
    expect(written(14n)!.liquidity).toBe(2n * 10n ** 18n);
    expect(written(14n)!.updatedAtBlock).toBe(BLOCK);
    expect(summary).toMatchObject({ outOfRange: 1, healed: 1 });
  });

  it("a failed read never moves it, whatever the batch reported for liquidity", async () => {
    const p = pos(15n, { liquidity: 10n ** 18n });
    const { context, written } = harness({
      positions: [p],
      states: () => [{ ...okState(15n, 0n), ok: false }],
    });
    await sweepUncollectedFees(context, ARGS);
    const row = written(15n)!;
    expect(row.liquidity).toBe(10n ** 18n);
    expect(row.isActive).toBe(true);
    expect(row.updatedAtBlock).toBe(ORIGINAL_BLOCK);
  });
});
