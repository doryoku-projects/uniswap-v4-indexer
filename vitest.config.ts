import { defineConfig } from "vitest/config";

/*
 * Test-only environment, so the suite is not gated on production RPC config.
 *
 * `assertRpcUrlsConfigured` (src/utils/rpc.ts) refuses to start when a chain in
 * the config has no RPC endpoint, because a public fallback cannot serve
 * `debug_traceTransaction` and the chain would silently record zero collected
 * fees. That gate is correct for a real run and wrong for a test run: the suite
 * must pass on a machine with no endpoints at all, and `src/indexer.test.ts`
 * deliberately drives chain 1 while only Avalanche is configured locally.
 *
 * Setting the documented opt-out here keeps the gate FAIL-SAFE BY DEFAULT — it
 * is relaxed in exactly one place, this file, rather than by weakening the check
 * into a warning that production would then ignore. Anything running outside
 * vitest still gets the hard failure.
 */
export default defineConfig({
  test: {
    env: {
      ENVIO_ALLOW_PUBLIC_RPC: "true",
    },
  },
});
