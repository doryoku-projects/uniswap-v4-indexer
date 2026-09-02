/*
 * Thin wrapper around `envio dev` that derives per-config storage settings.
 *
 * A single-chain config is a DIFFERENT dataset from the multi-chain one, with a
 * different `name:`. Sharing storage with it trips envio's incompatible-config
 * guard, so each config needs its own schema and ClickHouse database:
 *
 *   config.ethereum.yaml   -> ethereum
 *   config.yaml (or unset) -> public   (envio's own default)
 *
 * This exists because the alternative — remembering to pass ENVIO_PG_SCHEMA on
 * every invocation — has already failed twice in practice. An explicit value
 * still wins.
 */

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf("--config");
const configPath =
  flagIndex >= 0 && argv[flagIndex + 1] ? argv[flagIndex + 1] : process.env.ENVIO_CONFIG;

function slugFor(p) {
  if (!p) return null;
  const m = /^config\.(.+)\.yaml$/.exec(p.replace(/^.*\//, ""));
  if (!m) return null;
  const slug = m[1].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return slug.length ? slug : null;
}

const slug = slugFor(configPath);
const env = {
  ...process.env,
  ENVIO_PG_SCHEMA: process.env.ENVIO_PG_SCHEMA ?? slug ?? "public",
  ENVIO_CLICKHOUSE_DATABASE: process.env.ENVIO_CLICKHOUSE_DATABASE ?? slug ?? "default",
};

console.log(
  `dev: config=${configPath ?? "config.yaml"} pgSchema=${env.ENVIO_PG_SCHEMA} ` +
    `clickhouseDb=${env.ENVIO_CLICKHOUSE_DATABASE}` +
    (process.env.GRAPH_API_CHAIN_ID ? ` graphApi=chain ${process.env.GRAPH_API_CHAIN_ID}` : ""),
);

const child = spawn("pnpm", ["envio", "dev", ...argv], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
