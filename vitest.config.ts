import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `proxy/` is a self-contained package with its own deps, tsconfig and
    // test command. Without this exclusion the root run picks up its specs and
    // CI fails resolving `graphql`, which only exists under proxy/node_modules.
    exclude: ["**/node_modules/**", "**/dist/**", "proxy/**"],
  },
});
