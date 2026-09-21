/**
 * Parity test for the `sanitizeBD` fast path.
 *
 * The old body was `new BigDecimal(value.toFixed(40))`. The new one returns the
 * value untouched when it already fits in 40 dp. Envio's review asked for a
 * parity check over real values before taking the change, because an explicit
 * rounding mode would truncate where `toFixed` rounds. This is that check.
 */
import { describe, it, expect } from "vitest";
import { BigDecimal } from "envio";
import { sanitizeBD } from "./utils";

/** Exactly what `sanitizeBD` used to do. */
const legacy = (v: BigDecimal): BigDecimal => new BigDecimal(v.toFixed(40));

const SAMPLES: string[] = [
  "0", "1", "-1", "0.5", "-0.5",
  // Real running-total shapes: the ones that grow during a backfill.
  "1925.764791234567", "88799.999999999999999998", "1202325579734.963869266914909606",
  "31790.346764", "4122918409921686481449097", "0.000010998687252093",
  // Exactly at, just under, and just over the 40-dp boundary.
  "0." + "1".repeat(39), "0." + "1".repeat(40), "0." + "1".repeat(41),
  "0." + "9".repeat(41), "-0." + "9".repeat(41),
  // Half-way cases, where truncation and rounding visibly disagree.
  "0." + "0".repeat(40) + "5", "1." + "0".repeat(39) + "5", "-1." + "0".repeat(39) + "5",
  // Degenerate-pool scale: the astronomical artifacts the tick formulas produce.
  "1e40", "1e-40", "123456789012345678901234567890.123456789012345678901234567890",
];

describe("sanitizeBD — byte parity with the string-reparse it replaced", () => {
  for (const raw of SAMPLES) {
    it(`matches legacy for ${raw.length > 32 ? raw.slice(0, 32) + "…" : raw}`, () => {
      const v = new BigDecimal(raw);
      expect(sanitizeBD(v).toFixed()).toBe(legacy(v).toFixed());
    });
  }

  it("caps anything beyond 40 dp, and leaves 40-or-fewer untouched", () => {
    const over = new BigDecimal("0." + "1".repeat(45));
    expect(sanitizeBD(over).decimalPlaces()).toBe(40);

    const under = new BigDecimal("0.125");
    expect(sanitizeBD(under)).toBe(under); // same instance: no allocation
  });

  it("ROUNDS at the boundary rather than truncating", () => {
    // The whole reason the rounding mode is left unspecified. ROUND_DOWN would
    // give ...0 here; toFixed(40) and decimalPlaces(40) both give ...1.
    const v = new BigDecimal("0." + "0".repeat(39) + "05");
    expect(sanitizeBD(v).toFixed()).toBe(legacy(v).toFixed());
    expect(sanitizeBD(v).isZero()).toBe(false);
  });
});
