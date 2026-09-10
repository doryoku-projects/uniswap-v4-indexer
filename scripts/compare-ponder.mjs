/*
 * Parity report: this Envio indexer vs the reference Ponder indexer.
 *
 *   node scripts/compare-ponder.mjs [ponderUrl]
 *
 * Pulls every position from both, joins on tokenId, and classifies every field
 * difference. Ponder is the reference for SHAPE, not automatically for
 * correctness — it has known defects of its own (a trace-error classifier that
 * silently records 0 collected fees, and uncollected fees that are up to an
 * hour stale), so disagreements are attributed, not just counted.
 */
import { execFileSync } from "node:child_process";

const PONDER =
  process.argv[2] ?? "https://ponder-uniswap-v4-avalanche.up.railway.app/graphql";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "envio-postgres";
const SCHEMA = process.env.ENVIO_PG_SCHEMA ?? "avalanche";

// ── pull Ponder ─────────────────────────────────────────────────────────────
const FIELDS = `
  tokenId owner poolId tickLower tickUpper liquidity isActive isPriceable
  depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
  totalFeesCollected0 totalFeesCollected1
  totalFeesUncollected0 totalFeesUncollected1
  amount0 amount1 totalGasCostETH updatedAtBlock
`;

async function gql(query) {
  const r = await fetch(PONDER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function pullPonder() {
  const out = new Map();
  let after = null;
  for (;;) {
    const cur = after ? `, after: "${after}"` : "";
    const d = await gql(
      `{ positions(limit: 1000${cur}) { items { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    );
    for (const p of d.positions.items) out.set(String(p.tokenId), p);
    if (!d.positions.pageInfo.hasNextPage) break;
    after = d.positions.pageInfo.endCursor;
    process.stderr.write(`\r  ponder: ${out.size} positions`);
  }
  process.stderr.write(`\r  ponder: ${out.size} positions\n`);
  return out;
}

// ── pull Envio (straight from Postgres) ─────────────────────────────────────
function pullEnvio() {
  const sql = `
    select "tokenId", owner, coalesce(replace(pool,'43114_',''),'') , coalesce("tickLower"::text,''),
           coalesce("tickUpper"::text,''), liquidity, "isActive", "isPriceable",
           "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
           "totalFeesCollected0", "totalFeesCollected1",
           "totalFeesUncollected0", "totalFeesUncollected1",
           amount0, amount1, "totalGasCostETH", "updatedAtBlock", "feeBaselineValid"
    from ${SCHEMA}."Position" order by "tokenId";`;
  const raw = execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "envio-dev", "-t", "-A", "-F", "\t", "-c", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const out = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    out.set(String(f[0]), {
      tokenId: f[0], owner: f[1], poolId: f[2], tickLower: f[3], tickUpper: f[4],
      liquidity: f[5], isActive: f[6] === "t", isPriceable: f[7] === "t",
      depositedToken0: +f[8], depositedToken1: +f[9],
      withdrawnToken0: +f[10], withdrawnToken1: +f[11],
      totalFeesCollected0: +f[12], totalFeesCollected1: +f[13],
      totalFeesUncollected0: +f[14], totalFeesUncollected1: +f[15],
      amount0: +f[16], amount1: +f[17], totalGasCostETH: +f[18],
      updatedAtBlock: f[19], feeBaselineValid: f[20] === "t",
    });
  }
  return out;
}

// ── compare ─────────────────────────────────────────────────────────────────
const REL_TOL = 1e-9;
const close = (a, b) => {
  a = Number(a) || 0; b = Number(b) || 0;
  if (a === b) return true;
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? true : Math.abs(a - b) / m < REL_TOL;
};

const NUMERIC = [
  "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
  "totalFeesCollected0", "totalFeesCollected1",
  "totalFeesUncollected0", "totalFeesUncollected1",
  "amount0", "amount1", "totalGasCostETH",
];

console.log(`Comparing Envio (local ${SCHEMA}) vs Ponder (${new URL(PONDER).host})\n`);
const [ponder, envio] = [await pullPonder(), pullEnvio()];
console.log(`  envio : ${envio.size} positions\n`);

const onlyPonder = [...ponder.keys()].filter((k) => !envio.has(k));
const onlyEnvio = [...envio.keys()].filter((k) => !ponder.has(k));
const both = [...ponder.keys()].filter((k) => envio.has(k));

const agree = Object.fromEntries(NUMERIC.map((f) => [f, 0]));
const differ = Object.fromEntries(NUMERIC.map((f) => [f, []]));
let liqDiff = 0, activeDiff = 0, priceableDiff = 0, ownerDiff = 0;

for (const k of both) {
  const p = ponder.get(k), e = envio.get(k);
  for (const f of NUMERIC) {
    if (close(p[f], e[f])) agree[f]++;
    else differ[f].push({ tokenId: k, ponder: Number(p[f]) || 0, envio: e[f], baselineValid: e.feeBaselineValid });
  }
  if (String(p.liquidity) !== String(e.liquidity)) liqDiff++;
  if (Boolean(p.isActive) !== e.isActive) activeDiff++;
  if (Boolean(p.isPriceable) !== e.isPriceable) priceableDiff++;
  if (String(p.owner).toLowerCase() !== String(e.owner).toLowerCase()) ownerDiff++;
}

console.log("=== coverage ===");
console.log(`  in both            ${both.length}`);
console.log(`  only in ponder     ${onlyPonder.length}${onlyPonder.length ? "  e.g. " + onlyPonder.slice(0, 5).join(",") : ""}`);
console.log(`  only in envio      ${onlyEnvio.length}${onlyEnvio.length ? "  e.g. " + onlyEnvio.slice(0, 5).join(",") : ""}`);

console.log("\n=== identity fields ===");
console.log(`  liquidity mismatch   ${liqDiff}`);
console.log(`  isActive mismatch    ${activeDiff}`);
console.log(`  isPriceable mismatch ${priceableDiff}`);
console.log(`  owner mismatch       ${ownerDiff}`);

console.log("\n=== numeric fields (relative tolerance 1e-9) ===");
console.log("  field                     agree   differ   agree%");
for (const f of NUMERIC) {
  const d = differ[f].length, a = agree[f], t = a + d;
  console.log(`  ${f.padEnd(24)} ${String(a).padStart(6)} ${String(d).padStart(8)}   ${((a / t) * 100).toFixed(2)}%`);
}

// Attribute the collected-fee disagreements, which are the ones that matter.
for (const f of ["totalFeesCollected0", "totalFeesCollected1"]) {
  const d = differ[f];
  if (!d.length) continue;
  const envioZero = d.filter((x) => x.envio === 0 && x.ponder > 0);
  const ponderZero = d.filter((x) => x.ponder === 0 && x.envio > 0);
  const bothNonZero = d.filter((x) => x.ponder > 0 && x.envio > 0);
  const envioShort = bothNonZero.filter((x) => x.envio < x.ponder);
  const envioOver = bothNonZero.filter((x) => x.envio > x.ponder);
  const staleBaseline = d.filter((x) => !x.baselineValid);
  console.log(`\n=== ${f}: ${d.length} disagreements ===`);
  console.log(`  envio 0, ponder > 0        ${envioZero.length}   (envio missed it)`);
  console.log(`  ponder 0, envio > 0        ${ponderZero.length}   (ponder missed it - its known trace bug)`);
  console.log(`  both > 0, envio LOWER      ${envioShort.length}`);
  console.log(`  both > 0, envio HIGHER     ${envioOver.length}`);
  console.log(`  of all above, envio baseline unverified ${staleBaseline.length}`);
  const worst = [...d].sort((a, b) =>
    Math.abs(b.ponder - b.envio) - Math.abs(a.ponder - a.envio)).slice(0, 5);
  console.log("  largest absolute gaps:");
  for (const w of worst)
    console.log(`    tokenId ${String(w.tokenId).padEnd(6)} ponder=${w.ponder.toPrecision(8).padEnd(14)} envio=${w.envio.toPrecision(8).padEnd(14)} baselineValid=${w.baselineValid}`);
}

console.log(`
=== how to read the uncollected-fee rows ===
Both sides sample uncollected fees at their own refresh tick, so they are
snapshots taken at different moments and are EXPECTED to differ. Treat a
disagreement there as a staleness signal, not an error. The collected-fee rows
above are the real parity test: those are settled, immutable history.`);
