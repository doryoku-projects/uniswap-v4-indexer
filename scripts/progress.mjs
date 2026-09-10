/*
 * Indexing progress for a running indexer.
 *
 *   pnpm progress                  # one snapshot
 *   pnpm progress --watch          # refresh every 15s
 *   pnpm progress --config <path>  # only if you keep several config files
 *
 * NOTE: this branch has a single `config.yaml` that carries every chain as a
 * commentable block, so there is no `config.avalanche.yaml` to point at — the
 * default is correct. (The per-chain config files exist on the `envio` branch,
 * which is where `--config config.avalanche.yaml` came from.)
 *
 * Envio exposes everything needed on its Prometheus endpoint (default :9898)
 * but as raw counters with no percentage, because it has no notion of "done"
 * until it reaches head. The percentage is derived here from three numbers:
 *
 *   envio_progress_block         - last block whose events are fully processed
 *   envio_indexing_known_height  - the chain head the indexer knows about
 *   start_block (from config)    - where this indexer was told to begin
 *
 * Note: `envio dev` also has a native terminal UI with a progress bar. It is
 * suppressed when stdout is not a TTY (e.g. redirected to a log file). Run
 * `ENVIO_TUI=true pnpm dev --config <cfg>` in a real terminal to get it.
 */
import { readFileSync, readdirSync } from "node:fs";

const argv = process.argv.slice(2);
const watch = argv.includes("--watch");
const ci = argv.indexOf("--config");
const configPath =
  (ci >= 0 && argv[ci + 1]) || process.env.ENVIO_CONFIG || "config.yaml";

function loadDotEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* no .env is fine */
  }
}
loadDotEnv();

const METRICS_PORT = process.env.ENVIO_INDEXER_PORT ?? process.env.METRICS_PORT ?? 9898;

/** start_block per chain id, straight out of the active config. */
function startBlocks(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    // Naming a config that does not exist is the likeliest way to run this
    // wrong, because the per-chain files live on another branch. Say which
    // files are actually here instead of surfacing a bare ENOENT.
    const here = readdirSync(".")
      .filter((f) => /^config.*\.yaml$/.test(f))
      .sort();
    console.error(
      `no such config: ${path}\n` +
        `config files in this directory: ${here.join(", ") || "(none)"}\n` +
        `this branch keeps every chain in config.yaml, so omit --config.`,
    );
    process.exit(1);
  }
  const chains = text.slice(text.indexOf("\nchains:"));
  const out = new Map();
  let cur = null;
  for (const line of chains.split("\n")) {
    const id = /^\s*-\s*id:\s*(\d+)/.exec(line);
    if (id) {
      cur = id[1];
      out.set(cur, 0);
      continue;
    }
    const sb = /^\s*start_block:\s*(\d+)/.exec(line);
    if (sb && cur) out.set(cur, Number(sb[1]));
  }
  return out;
}

/** Parse Prometheus text into {name -> [{labels, value}]}. */
function parseMetrics(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+]+)$/.exec(line.trim());
    if (!m) continue;
    const labels = {};
    if (m[2]) {
      for (const kv of m[2].slice(1, -1).split(",")) {
        const [k, v] = kv.split("=");
        if (k) labels[k.trim()] = (v ?? "").replace(/"/g, "");
      }
    }
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push({ labels, value: Number(m[3]) });
  }
  return out;
}

const pick = (metrics, name, chainId) =>
  (metrics.get(name) ?? []).find((s) => !chainId || s.labels.chainId === chainId)?.value;

const fmt = (n) => (n == null ? "?" : Math.round(n).toLocaleString("en-US"));
function dur(sec) {
  if (!isFinite(sec) || sec <= 0) return "?";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function bar(pct, width = 32) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

const starts = startBlocks(configPath);
let last = null;

async function snapshot() {
  let metrics;
  try {
    const res = await fetch(`http://localhost:${METRICS_PORT}/metrics`, {
      signal: AbortSignal.timeout(10_000),
    });
    metrics = parseMetrics(await res.text());
  } catch (err) {
    console.log(
      `indexer not reachable on :${METRICS_PORT} — is it running? (${err instanceof Error ? err.message : err})`,
    );
    return;
  }

  const now = Date.now();
  const lines = [];
  for (const [chainId, startBlock] of starts) {
    const block = pick(metrics, "envio_progress_block", chainId);
    const head = pick(metrics, "envio_indexing_known_height", chainId);
    const events = pick(metrics, "envio_progress_events", chainId);
    const buffered = pick(metrics, "envio_indexing_buffer_block", chainId);
    const ready = pick(metrics, "envio_progress_ready", chainId);
    if (block == null || head == null) continue;

    const total = head - startBlock;
    const done = Math.max(0, block - startBlock);
    const pct = total > 0 ? (done * 100) / total : 0;

    // Rate and ETA from the gap since the previous snapshot in --watch mode.
    let eta = "";
    if (last && last.byChain[chainId] && now > last.t) {
      const dBlocks = block - last.byChain[chainId].block;
      const dSec = (now - last.t) / 1000;
      if (dBlocks > 0) {
        const bps = dBlocks / dSec;
        eta = `  ${fmt(bps)} blk/s  ETA ${dur((total - done) / bps)}`;
      }
    }

    lines.push(
      `chain ${chainId}  ${bar(pct)} ${pct.toFixed(2)}%${ready ? "  CAUGHT UP" : ""}`,
    );
    lines.push(
      `  block ${fmt(block)} / ${fmt(head)}   (${fmt(done)} of ${fmt(total)})${eta}`,
    );
    lines.push(
      `  events ${fmt(events)}   fetched ahead to ${fmt(buffered)}`,
    );
  }

  // The RPC-backed effects are usually the real pacing constraint, so surface
  // their queue depth: a persistently non-zero queue means the rate limit, not
  // the event volume, is what you are waiting on.
  const effectNames = new Set(
    (metrics.get("envio_effect_call_total") ?? []).map((s) => s.labels.effect),
  );
  for (const name of effectNames) {
    const calls = (metrics.get("envio_effect_call_total") ?? []).find(
      (s) => s.labels.effect === name,
    )?.value;
    const queue = (metrics.get("envio_effect_queue") ?? []).find(
      (s) => s.labels.effect === name,
    )?.value;
    const cached = (metrics.get("envio_effect_cache") ?? []).find(
      (s) => s.labels.effect === name,
    )?.value;
    lines.push(
      `  effect ${name}: ${fmt(calls)} calls, ${fmt(cached)} cached, queue ${fmt(queue)}`,
    );
  }

  last = {
    t: now,
    byChain: Object.fromEntries(
      [...starts.keys()].map((c) => [
        c,
        { block: pick(metrics, "envio_progress_block", c) },
      ]),
    ),
  };

  console.log(
    (watch ? `\n[${new Date().toLocaleTimeString()}] ` : "") + lines.join("\n  ").replace(/^ {2}/, ""),
  );
}

await snapshot();
if (watch) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 15_000));
    await snapshot();
  }
}
