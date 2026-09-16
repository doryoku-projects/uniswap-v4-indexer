/*
 * The startup gate that refuses to index a chain with no RPC endpoint.
 *
 * THE FAILURE IT EXISTS FOR, stated once: `getRpcUrl` falls back to a public
 * drpc.org endpoint when a chain's env var is unset. A public endpoint will not
 * serve `debug_traceTransaction`, so the trace path degrades and the chain
 * records ZERO collected fees — while syncing from HyperSync to 100%, throwing
 * nothing, and showing green. Zero fees is indistinguishable from a position
 * that earned nothing, so nothing downstream can detect it either.
 *
 * With `config.yaml` as it ships (chains 1, 10, 8453, 42161, 43114, 4663) and a
 * typical `.env`, only 43114 has a real endpoint — five of six chains would be
 * in that state. That is why this is fatal rather than logged.
 *
 * These tests manipulate `process.env` directly, including the opt-out that
 * `vitest.config.ts` sets for the rest of the suite, and restore it afterwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertRpcUrlsConfigured, chainsOnPublicFallback } from "../src/utils/rpc";

const TOUCHED = [
  "ENVIO_ALLOW_PUBLIC_RPC",
  "ENVIO_MAINNET_RPC_URL",
  "ENVIO_AVALANCHE_RPC_URL",
  "ENVIO_BASE_RPC_URL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  // Start from "nothing configured", including no opt-out, so each test states
  // its own world rather than inheriting the suite's.
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("assertRpcUrlsConfigured", () => {
  it("THROWS when an indexed chain has no endpoint", () => {
    // The whole point. Without this the run proceeds and books zero fees.
    expect(() => assertRpcUrlsConfigured([1])).toThrow(/ENVIO_MAINNET_RPC_URL/);
  });

  it("names every missing chain, not just the first", () => {
    // A deploy should learn its full shopping list in one go.
    let message = "";
    try {
      assertRpcUrlsConfigured([1, 8453, 43114]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("ENVIO_MAINNET_RPC_URL");
    expect(message).toContain("ENVIO_BASE_RPC_URL");
    expect(message).toContain("ENVIO_AVALANCHE_RPC_URL");
    expect(message).toContain("3 indexed chain(s)");
  });

  it("says WHY, so the failure is actionable rather than cryptic", () => {
    // A startup crash that does not explain itself gets worked around by
    // deleting the check.
    expect(() => assertRpcUrlsConfigured([1])).toThrow(/debug_traceTransaction/);
    expect(() => assertRpcUrlsConfigured([1])).toThrow(/ZERO collected fees/);
  });

  it("passes when every indexed chain has an endpoint", () => {
    process.env.ENVIO_AVALANCHE_RPC_URL = "https://example-archive.invalid";
    expect(() => assertRpcUrlsConfigured([43114])).not.toThrow();
  });

  it("treats an EMPTY var as unset — the shape a committed .env actually has", () => {
    // `.env` ships these as `""`, which is falsy for `||` in `getRpcUrl` and so
    // hits the public fallback. It must not read as configured.
    process.env.ENVIO_AVALANCHE_RPC_URL = "   ";
    expect(() => assertRpcUrlsConfigured([43114])).toThrow(/ENVIO_AVALANCHE_RPC_URL/);
  });

  it("passes vacuously for no chains, so an unreadable config cannot block a run", () => {
    expect(() => assertRpcUrlsConfigured([])).not.toThrow();
  });

  it("warns per chain instead of throwing under the documented opt-out", () => {
    process.env.ENVIO_ALLOW_PUBLIC_RPC = "true";
    const warn = vi.fn();

    expect(() => assertRpcUrlsConfigured([1, 8453], { warn })).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("PUBLIC RPC");
    expect(messages).toContain("recorded as 0");
  });

  it("only accepts the exact opt-out value — a stray truthy string still fails", () => {
    // Otherwise `ENVIO_ALLOW_PUBLIC_RPC=false` would disable the gate.
    for (const v of ["false", "1", "yes", ""]) {
      process.env.ENVIO_ALLOW_PUBLIC_RPC = v;
      expect(() => assertRpcUrlsConfigured([1])).toThrow();
    }
  });
});

describe("chainsOnPublicFallback", () => {
  it("reports exactly the unconfigured chains, sorted", () => {
    process.env.ENVIO_AVALANCHE_RPC_URL = "https://example-archive.invalid";
    expect(chainsOnPublicFallback([8453, 1, 43114])).toEqual([1, 8453]);
  });

  it("ignores a chain with no known env var, leaving getRpcUrl to reject it", () => {
    // 999999 has no entry, so this function must not claim it is "configured"
    // OR that it is missing — it is simply not its business.
    expect(chainsOnPublicFallback([999999])).toEqual([]);
  });
});
