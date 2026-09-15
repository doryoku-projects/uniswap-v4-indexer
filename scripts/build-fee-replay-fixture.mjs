/*
 * Rebuild `src/fixtures/avalanche-settlement-traces.json`, the fixture
 * `src/feeReplay.test.ts` replays against.
 *
 *     node scripts/build-fee-replay-fixture.mjs <audit.csv> [cacheDir]
 *
 * <audit.csv> is the collected-fee audit — one row per position the deployed
 * indexer got wrong, carrying its settlement transaction hashes and the
 * `expected_collected_token0/1` decoded from the chain. [cacheDir] (default
 * ./.fee-replay-cache) holds the raw `debug_traceTransaction` and
 * `eth_getTransactionReceipt` responses so re-running is free.
 *
 * WHY A PRUNING STEP. The raw traces for these 38 transactions are ~3.5MB,
 * which is not a thing to commit. Everything the indexer actually reads is
 * kept VERBATIM — every `PoolManager.modifyLiquidity` frame with its full
 * calldata and returndata, the call-tree shape around it (so the depth-first
 * walk in `framesFromTrace` is exercised for real), and the PoolManager's own
 * ModifyLiquidity logs. Every other frame keeps only its `to` and its 4-byte
 * selector, and every other log is dropped: 3.5MB to ~120KB.
 *
 * The RPC endpoint comes from ENVIO_AVALANCHE_RPC_URL in .env and is never
 * printed — not in a log line, not in an error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV = process.argv[2];
const CACHE = process.argv[3] ?? path.join(REPO, ".fee-replay-cache");
const OUT = path.join(REPO, "src/fixtures/avalanche-settlement-traces.json");

if (!CSV) {
  console.error("usage: node scripts/build-fee-replay-fixture.mjs <audit.csv> [cacheDir]");
  process.exit(1);
}

const CHAIN_ID = 43114;
const POOL_MANAGER = "0x06380c0e0912312b5150364b9dc4542ba0dbbc85";
/** modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes) */
const MODIFY_SELECTOR = "0x5a6bcfda";
/** keccak("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)") */
const MODIFY_TOPIC = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

/*
 * The sample, chosen to span the audit rather than to be easy: both cases
 * (MISSED_ALL and PARTIAL), single- and multi-settlement positions, 6- and
 * 18-decimal tokens, and the four positions the diagnosis turned on —
 * 43114_3132 (a fee-bearing INCREASE, the counterexample to "the increase path
 * is safe"), 43114_1356 (pool-level vs position-level fee growth diverging
 * permanently at mint), 43114_378 (accrual inside the settling block, invisible
 * to a block-granular read), and 43114_7842 (two frames identical in salt,
 * ticks and delta).
 */
const SELECTION = [
  "43114_3132", "43114_1356", "43114_378", "43114_7842", "43114_1121",
  "43114_7718", "43114_5391", "43114_9", "43114_6871", "43114_3039",
  "43114_2856", "43114_7769", "43114_7284", "43114_7981", "43114_1405",
  "43114_380", "43114_2664", "43114_7729",
];

const envLine = fs
  .readFileSync(path.join(REPO, ".env"), "utf8")
  .split("\n")
  .find((l) => l.startsWith("ENVIO_AVALANCHE_RPC_URL="));
if (!envLine) throw new Error("ENVIO_AVALANCHE_RPC_URL is not set in .env");
const RPC_URL = envLine.slice("ENVIO_AVALANCHE_RPC_URL=".length).trim().replace(/^["']|["']$/g, "");

let rpcId = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const body = await res.json().catch(() => null);
    if (body?.result) return body.result;
    // HOST ONLY in the message — never the path, never the key.
    const host = new URL(RPC_URL).host;
    const detail = body?.error?.message ?? `HTTP ${res.status}`;
    if (attempt === 4) throw new Error(`${method} failed at ${host}: ${detail}`);
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}

const rows = (() => {
  const lines = fs.readFileSync(CSV, "utf8").trim().split("\n");
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i], v])));
})();

const isModifyFrame = (n) =>
  typeof n.to === "string" &&
  n.to.toLowerCase() === POOL_MANAGER &&
  typeof n.input === "string" &&
  n.input.toLowerCase().startsWith(MODIFY_SELECTOR) &&
  typeof n.output === "string" &&
  n.output.length >= 2 + 128;

/** Keep the frames that matter verbatim and the tree that leads to them. */
function prune(node) {
  const kids = (node.calls ?? []).map(prune).filter(Boolean);
  const keep = isModifyFrame(node);
  if (!keep && kids.length === 0) return null;
  const out = { to: node.to };
  if (node.error) out.error = node.error;
  if (keep) {
    out.input = node.input;
    out.output = node.output;
  } else {
    out.input = typeof node.input === "string" ? node.input.slice(0, 10) : "0x";
  }
  if (kids.length) out.calls = kids;
  return out;
}

const fixture = { chainId: CHAIN_ID, poolManager: POOL_MANAGER, positions: [], transactions: {} };
for (const id of SELECTION) {
  const r = rows.find((x) => x.position_id === id);
  if (!r) throw new Error(`position ${id} is not in ${path.basename(CSV)}`);
  fixture.positions.push({
    positionId: id,
    tokenId: r.token_id,
    case: r.case,
    token0Symbol: r.token0_symbol,
    token1Symbol: r.token1_symbol,
    decimals0: Number(r.token0_decimals),
    decimals1: Number(r.token1_decimals),
    deployed0: r.deployed_collected_token0,
    deployed1: r.deployed_collected_token1,
    expected0: r.expected_collected_token0,
    expected1: r.expected_collected_token1,
    txHashes: r.settlement_tx_hashes.trim().split(/\s+/),
  });
}

fs.mkdirSync(CACHE, { recursive: true });
for (const tx of new Set(fixture.positions.flatMap((p) => p.txHashes))) {
  const cached = path.join(CACHE, `${tx}.json`);
  if (!fs.existsSync(cached)) {
    const trace = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    fs.writeFileSync(cached, JSON.stringify({ trace, receipt }));
    console.log(`fetched ${tx}`);
  }
  const raw = JSON.parse(fs.readFileSync(cached, "utf8"));
  fixture.transactions[tx] = {
    trace: prune(raw.trace),
    logs: raw.receipt.logs
      .filter(
        (l) =>
          l.address.toLowerCase() === POOL_MANAGER && l.topics[0].toLowerCase() === MODIFY_TOPIC,
      )
      .map((l) => ({ logIndex: Number(l.logIndex), topics: l.topics, data: l.data })),
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture));
const frames = Object.values(fixture.transactions).reduce((n, t) => {
  const walk = (x) => (x.output ? 1 : 0) + (x.calls ?? []).reduce((a, c) => a + walk(c), 0);
  return n + walk(t.trace);
}, 0);
const logs = Object.values(fixture.transactions).reduce((n, t) => n + t.logs.length, 0);
console.log(
  `wrote ${path.relative(REPO, OUT)} — ${fixture.positions.length} positions, ` +
    `${Object.keys(fixture.transactions).length} txs, ${frames} frames, ${logs} logs, ` +
    `${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`,
);
