/*
 * The uncollected-fee rule, and the two beliefs that used to be baked into it.
 *
 * Both were wrong in the same direction — silently reporting zero where the
 * chain pays a real fee — and both were load-bearing enough that the fix is only
 * safe with the counter-examples written down:
 *
 *   1. "an out-of-range position provably has zero uncollected fees"
 *   2. "a backwards delta is a stale read, so clamp it to zero"
 *
 * (1) lived at the sweep's call site and (2) here. (1) is refuted by the fixture
 * cases below, which are REAL Avalanche settlements: the position was out of
 * range at the time and the PoolManager still returned a non-zero `feesAccrued`.
 * (2) is refuted by v4 itself — `Position.update` subtracts the accumulators
 * inside `unchecked`, so a rollover is expected arithmetic, not corruption.
 */
import { describe, it, expect } from "vitest";
import { calculateUncollectedFees, Q128, MAX_UINT256 } from "./utils/fees";

describe("calculateUncollectedFees", () => {
  it("is zero when the position holds no liquidity, whatever the growth", () => {
    // The contract multiplies by liquidity, so a closed position owes nothing no
    // matter how far the range's growth has moved since.
    expect(calculateUncollectedFees(0n, 9n * Q128, 9n * Q128, 0n, 0n)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it("books delta * liquidity / 2^128 per token", () => {
    const r = calculateUncollectedFees(1_000n, 5n * Q128, 3n * Q128, 1n * Q128, 1n * Q128);
    expect(r.amount0).toBe(4_000n);
    expect(r.amount1).toBe(2_000n);
  });

  it("settles each token independently", () => {
    // Asymmetric accrual is normal — a position can earn in one token only.
    const r = calculateUncollectedFees(1_000n, 5n * Q128, 1n * Q128, 1n * Q128, 1n * Q128);
    expect(r.amount0).toBe(4_000n);
    expect(r.amount1).toBe(0n);
  });

  it("FOLLOWS a wrapped accumulator instead of reading it as a negative delta", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. v4's fee growth is unchecked uint256
    // and wraps by design. Signed subtraction sees the rollover as "backwards"
    // and clamps the leg to zero, losing the fee outright.
    const before = MAX_UINT256 - 2n * Q128 + 1n; // near the top of the ring
    const after = (before + 3n * Q128) & MAX_UINT256; // advanced 3 units, wrapping
    expect(after < before).toBe(true); // the exact shape the old clamp discarded

    const r = calculateUncollectedFees(5n, after, 0n, before, 0n);
    expect(r.amount0).toBe(15n); // 3 units of growth * L=5
  });

  it("still drops a genuinely backwards baseline rather than inventing ~2^256", () => {
    // The one case the old clamp was right about: a baseline AHEAD of current
    // growth is a stale or never-written value, not a rollover. Multiplying that
    // delta out would manufacture an astronomical fee.
    const r = calculateUncollectedFees(1_000n, 1n * Q128, 1n * Q128, 9n * Q128, 9n * Q128);
    expect(r).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("has no magnitude cap — a large legitimate fee survives", () => {
    // A cheap 18-decimal token can legitimately accrue a huge raw amount. An
    // earlier version capped this at 1e6 and silently dropped real fees.
    const liquidity = 10n ** 24n;
    const r = calculateUncollectedFees(liquidity, 10n ** 9n * Q128, 0n, 0n, 0n);
    expect(r.amount0).toBe(10n ** 9n * liquidity);
  });
});

/*
 * Real Avalanche settlements, read from the chain: `feeGrowthInside` and the
 * position's own `feeGrowthInsideLast` at the block BEFORE the settle, and
 * `paid`, the `feesAccrued` the PoolManager actually returned in that
 * transaction's call trace.
 *
 * Every one of these positions was OUT OF RANGE at the time. That is the whole
 * point: the sweep used to skip them and write zero.
 */
describe("out-of-range positions, against what the contract actually paid", () => {
  const CASES = [
    {
      tokenId: 3247,
      poolTick: -2n,
      tickLower: -1n,
      tickUpper: 2n,
      liquidity: 13982666218363n,
      fg0: 42318947348798693948388388879872808491n,
      fg1: 42318943200416384067507574127656732362n,
      last0: 42318941732763366800020694494233778284n,
      last1: 42318938511924601012294116495801244774n,
      paid0: 230770n,
      paid1: 192656n,
    },
    {
      tokenId: 5308,
      poolTick: -251477n,
      tickLower: -251460n,
      tickUpper: -251450n,
      liquidity: 7247621539749419n,
      fg0: 14703539945520723892879593228877956273n,
      fg1: 0n,
      last0: 0n,
      last1: 0n,
      paid0: 313168424752616n,
      paid1: 0n,
    },
    {
      tokenId: 5444,
      poolTick: -8n,
      tickLower: -11n,
      tickUpper: -8n,
      liquidity: 13911137963723n,
      fg0: 245777133481849191496670972356608n,
      fg1: 247317343132885778284224752332363n,
      last0: 244649697685636638417600690304641n,
      last1: 245811865114863580696132760825475n,
      paid0: 46090n,
      paid1: 61545n,
    },
  ];

  for (const c of CASES) {
    it(`token ${c.tokenId} was owed exactly what the contract paid`, () => {
      // Out of range on v4's own test: tickLower <= tick < tickUpper.
      const inRange = c.poolTick >= c.tickLower && c.poolTick < c.tickUpper;
      expect(inRange).toBe(false);

      const r = calculateUncollectedFees(c.liquidity, c.fg0, c.fg1, c.last0, c.last1);
      expect(r.amount0).toBe(c.paid0);
      expect(r.amount1).toBe(c.paid1);
      // ...and it was not zero, which is what the old range gate reported.
      expect(r.amount0 + r.amount1).toBeGreaterThan(0n);
    });
  }
});
