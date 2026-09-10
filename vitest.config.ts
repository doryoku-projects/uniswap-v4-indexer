import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The block-replay tests (createTestIndexer without `simulate`) fetch real
    // chain data from HyperSync, which routinely takes longer than vitest's
    // 5s default — especially the first call on a chain, which also resolves
    // token metadata over RPC. The pure-math and mock-RPC suites finish in
    // milliseconds either way, so a generous ceiling costs nothing.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
