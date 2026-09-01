/*
 * Runs the indexer and the Graph-dialect proxy as one foreground command.
 *
 * They cannot be one process: envio serves GraphQL through Hasura, and its own
 * Express server (Main.res.mjs) has fixed routes with no extension point. So
 * this supervises both, forwards signals, and exits as soon as either dies —
 * a half-running stack is worse than a stopped one.
 */

import { spawn } from "node:child_process";

const CHAIN_ID = process.env.PROXY_CHAIN_ID;
const CONFIG = process.env.ENVIO_CONFIG;

if (!CHAIN_ID) {
  console.error(
    "dev-all: PROXY_CHAIN_ID is required — the proxy serves exactly one chain.\n" +
      "  e.g. PROXY_CHAIN_ID=1 ENVIO_CONFIG=config.ethereum.yaml pnpm dev:all",
  );
  process.exit(1);
}

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

run("indexer", "pnpm", ["envio", "dev", ...(CONFIG ? ["--config", CONFIG] : [])]);

// The proxy only needs Hasura, which envio brings up before it starts indexing.
// It retries on its own, so there is no ordering requirement here.
run("proxy", "pnpm", ["--dir", "proxy", "dev"], {
  PROXY_CHAIN_ID: CHAIN_ID,
  PROXY_HASURA_URL: process.env.PROXY_HASURA_URL ?? "http://localhost:8080/v1/graphql",
  PROXY_PORT: process.env.PROXY_PORT ?? "4350",
});
