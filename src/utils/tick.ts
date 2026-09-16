import { BigDecimal } from "envio";
import { ONE_BD, ZERO_BI } from "./constants";
import { fastExponentiation } from "./index";

export function createInitialTick(
  tickId: string,
  tickIdx: number,
  poolId: string,
  timestamp: bigint,
  blockNumber: bigint,
  chainId: bigint
) {
  const tick = {
    id: tickId,
    chainId,
    pool_id: poolId,
    tickIdx: BigInt(tickIdx),
    poolAddress: poolId,
    createdAtTimestamp: timestamp,
    createdAtBlockNumber: blockNumber,
    liquidityGross: ZERO_BI,
    liquidityNet: ZERO_BI,
    price0: ONE_BD,
    price1: ONE_BD,
  };

  /*
   * Each price is derived by DIRECT exponentiation. `price1` must not be
   * computed as `1 / price0`.
   *
   * `price0` is 1.0001^tick (token1/token0) and `price1` its reciprocal, so
   * inverting looks equivalent and is not. The tick domain is +/-887272, which
   * puts the true values between ~2.9e-39 and ~3.4e38, and BOTH rounding steps
   * on the way to a stored `price0` destroy the small end:
   *
   *   - `fastExponentiation` with a NEGATIVE power returns
   *     `safeDiv(ONE_BD, 1.0001^|tick|)`, and `safeDiv` is bignumber.js `div`
   *     at the default 20 decimal places. Anything under 1e-20 is already 0
   *     here, before this function sees it.
   *   - `.toFixed(18)` then flattens anything under 1e-18.
   *
   * So at a deeply negative tick `price0` is legitimately 0 — no fixed-decimal
   * representation holds 2.9e-39 — but `1 / 0` via `safeDiv` is 0 too, and that
   * zero was being STORED as `price1` where the real value is up to 3.4e38, a
   * number the column holds without trouble. Measured on the Avalanche
   * snapshot: 685 of 4091 ticks had `price1 = 0` for this reason.
   *
   * Asking for the negated power gives each side its own direct computation, so
   * neither is the reciprocal of a value that has already been rounded. Each now
   * underflows only when ITS OWN value is genuinely unrepresentable, which is
   * correct and symmetric: at an extreme negative tick `price0` is 0 and
   * `price1` is huge, and at an extreme positive tick the reverse.
   *
   * To be precise about the mechanism, since an earlier version of this comment
   * got it wrong: this does NOT move the small side onto a multiplication-only
   * path. `price0` is always `fastExponentiation(base, tickIdx)`, so at a
   * negative tick it still goes through that function's dividing branch. What
   * makes the result correct is that `safeDiv`'s floor (~5e-21) sits a hundred
   * times BELOW the `.toFixed(18)` storage floor (5e-19) — so that division can
   * only ever zero a value the column could not have stored anyway. The
   * previously-lost `price1` is now computed at a positive power, where nothing
   * rounds it at all.
   */
  const price0Raw = fastExponentiation(new BigDecimal("1.0001"), tickIdx);
  const price1Raw = fastExponentiation(new BigDecimal("1.0001"), -tickIdx);

  // Quantize for storage. Postgres `numeric` has no trouble with the integer
  // part; the cap is about bounding the fractional tail, not the magnitude.
  tick.price0 = new BigDecimal(price0Raw.toFixed(18));
  tick.price1 = new BigDecimal(price1Raw.toFixed(18));

  return tick;
}
