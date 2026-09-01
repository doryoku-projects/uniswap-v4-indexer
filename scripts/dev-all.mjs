/*
 * Runs the indexer and the Graph-dialect proxy as one foreground command.
 *
 * They cannot be one process: envio serves GraphQL through Hasura, and its own
 * Express server (Main.res.mjs) has fixed routes with no extension point. So
 * this supervises both, forwards signals, and exits as soon as either dies —
 * a half-running stack is worse than a stopped one.
 */

import { spawn } from "node:child_process";

import net from "node:net";

const CHAIN_ID = process.env.PROXY_CHAIN_ID;
const CONFIG = process.env.ENVIO_CONFIG;

if (!CHAIN_ID) {
  console.error(
    "dev-all: PROXY_CHAIN_ID is required — the proxy serves exactly one chain.\n" +
      "  e.g. PROXY_CHAIN_ID=1 ENVIO_CONFIG=config.ethereum.yaml pnpm dev:all",
  );
  process.exit(1);
}

/*
 * A single-chain config is a DIFFERENT dataset from the full multi-chain one,
 * with a different `name:`. Sharing storage with it trips envio's
 * incompatible-config guard, so each config gets its own schema and ClickHouse
 * database, derived from the config filename:
 *
 *   config.ethereum.yaml   -> ethereum
 *   config.yaml (or unset) -> public   (envio's own default)
 *
 * Deriving rather than requiring is the point: the documented command works as
 * written. An explicit ENVIO_PG_SCHEMA / ENVIO_CLICKHOUSE_DATABASE still wins.
 */
function slugFromConfig(configPath) {
  if (!configPath) return null;
  const base = configPath.replace(/^.*\//, "");
  const m = /^config\.(.+)\.yaml$/.exec(base);
  if (!m) return null;
  const slug = m[1].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return slug.length ? slug : null;
}

const slug = slugFromConfig(CONFIG);
const pgSchema = process.env.ENVIO_PG_SCHEMA ?? slug ?? "public";
const clickhouseDb = process.env.ENVIO_CLICKHOUSE_DATABASE ?? slug ?? "default";
const indexerPort = process.env.ENVIO_INDEXER_PORT ?? "9898";
const proxyPort = process.env.PROXY_PORT ?? "4350";

console.log(
  `dev-all: chain=${CHAIN_ID} config=${CONFIG ?? "config.yaml"} ` +
    `pgSchema=${pgSchema} clickhouseDb=${clickhouseDb} ` +
    `indexerPort=${indexerPort} proxyPort=${proxyPort}`,
);

/** Fail with a usable message instead of an unhandled EADDRINUSE stack. */
function checkPortFree(port, label) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(
          `dev-all: ${label} port ${port} is already in use — another dev:all is probably still running.\n` +
            `  lsof -ti tcp:${port} | xargs kill`,
        );
        process.exit(1);
      }
      resolve();
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port);
  });
}

await checkPortFree(proxyPort, "proxy");
await checkPortFree(indexerPort, "indexer");

const children = [];
let shuttingDown = false;

function run(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const tag = (stream, prefix) => {
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) console.log(`${prefix} ${l}`);
    });
  };
  tag(child.stdout, `[${name}]`);
  tag(child.stderr, `[${name}]`);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`dev-all: ${name} exited (code=${code} signal=${signal}) — stopping the stack`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 2000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}

run("indexer", "pnpm", ["envio", "dev", ...(CONFIG ? ["--config", CONFIG] : [])], {
  ENVIO_PG_SCHEMA: pgSchema,
  ENVIO_CLICKHOUSE_DATABASE: clickhouseDb,
  ENVIO_INDEXER_PORT: indexerPort,
});

// The proxy only needs Hasura, which envio brings up before it starts indexing.
// It retries on its own, so there is no ordering requirement here.
run("proxy", "pnpm", ["--dir", "proxy", "dev"], {
  PROXY_CHAIN_ID: CHAIN_ID,
  PROXY_HASURA_URL: process.env.PROXY_HASURA_URL ?? "http://localhost:8080/v1/graphql",
  PROXY_PORT: proxyPort,
});
