/**
 * Unit tests for the guards that keep the position surface honest.
 *
 * These are pure (or RPC-mocked) rather than E2E, because each one exists to
 * prevent a specific class of PLAUSIBLE WRONG NUMBER — a value that is not an
 * error and looks like data. A snapshot test cannot fail on those; it just
 * records the wrong number.
 */

import { describe, it, expect } from "vitest";

import { isDegenerate } from "./utils/positions";
import { TickMath } from "./utils/liquidityMath/tickMath";

describe("isDegenerate — the astronomical-amount guard", () => {
  const MID_SQRT = 79228162514264337593543950336n; // price 1.0

  it("passes an ordinary pool", () => {
    expect(isDegenerate(0n, MID_SQRT)).toBe(false);
    expect(isDegenerate(-100n, MID_SQRT)).toBe(false);
    expect(isDegenerate(200000n, MID_SQRT)).toBe(false);
  });

  it("flags a pool at either tick boundary", () => {
    // At the domain edge the amount formulas lose all precision and return
    // values that are numerically enormous and physically meaningless. Ponder
    // zeroes amounts here rather than publishing the artifact.
    expect(isDegenerate(TickMath.MAX_TICK, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MIN_TICK, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MAX_TICK + 1n, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MIN_TICK - 1n, MID_SQRT)).toBe(true);
  });

  it("flags a pool at either sqrt-price boundary", () => {
    expect(isDegenerate(0n, TickMath.MAX_SQRT_RATIO)).toBe(true);
    expect(isDegenerate(0n, TickMath.MIN_SQRT_RATIO)).toBe(true);
  });

  it("flags an uninitialized pool, whose sqrtPrice reads as zero", () => {
    // `pool.sqrtPrice ?? 0n` is what the handler passes when a pool has not been
    // initialized. Zero is below MIN_SQRT_RATIO, so it must be caught — treating
    // it as a real price is how a position gets a fabricated valuation.
    expect(isDegenerate(0n, 0n)).toBe(true);
  });
});

describe("POSITION_MANAGERS must equal config.yaml", () => {
  /*
   * The sender filter compares `event.params.sender` against this table, so a
   * wrong or missing address means every ModifyLiquidity on that chain fails the
   * comparison and NO positions are indexed for it — silently, with correct-
   * looking pool and token data alongside. The table's own docstring states that
   * keeping it equal to config.yaml is a maintenance rule; this makes it a
   * failing test instead of a hope.
   */
  const readFileSync = require("node:fs").readFileSync;

  function tableFromSource(): Map<number, string> {
    const src = readFileSync("src/utils/v4Addresses.ts", "utf8") as string;
    const start = src.indexOf("const POSITION_MANAGERS");
    const blk = src.slice(start, src.indexOf("};", start));
    const out = new Map<number, string>();
    for (const m of blk.matchAll(/^\s*(\d+):\s*"(0x[0-9a-fA-F]{40})"/gm)) {
      out.set(Number(m[1]), m[2]!.toLowerCase());
    }
    return out;
  }

  function configPositionManagers(): Map<number, string> {
    const cfg = readFileSync("config.yaml", "utf8") as string;
    const out = new Map<number, string>();
    let chainId: number | null = null;
    let contract: string | null = null;
    // Commented-out chains count: their addresses are still the source of truth
    // for the day someone uncomments them.
    for (const raw of cfg.split("\n")) {
      const t = raw.trim().replace(/^#/, "").trim();
      const id = /^-?\s*id:\s*(\d+)/.exec(t);
      if (id) {
        chainId = Number(id[1]);
        contract = null;
        continue;
      }
      const name = /^-?\s*name:\s*(\w+)/.exec(t);
      if (name) {
        contract = name[1]!;
        continue;
      }
      const addr = /^-\s*(0x[0-9a-fA-F]{40})/.exec(t);
      if (addr && chainId !== null && contract === "PositionManager" && !out.has(chainId)) {
        out.set(chainId, addr[1]!.toLowerCase());
      }
    }
    return out;
  }

  it("covers every chain config.yaml declares a PositionManager for", () => {
    const table = tableFromSource();
    const cfg = configPositionManagers();
    expect(cfg.size).toBeGreaterThan(0);
    const missing = [...cfg.keys()].filter((c) => !table.has(c));
    expect(missing, `chains in config.yaml with no POSITION_MANAGERS entry: ${missing}`).toEqual([]);
  });

  it("agrees with config.yaml on every address", () => {
    const table = tableFromSource();
    const cfg = configPositionManagers();
    const wrong: string[] = [];
    for (const [chainId, addr] of table) {
      const expected = cfg.get(chainId);
      if (expected && expected !== addr) wrong.push(`${chainId}: table=${addr} config=${expected}`);
    }
    expect(wrong, `PositionManager mismatches: ${wrong.join("; ")}`).toEqual([]);
  });
});
