/*
 * Unbiased audit: does the no-trace fee method match what the contract paid?
 *
 *   node scripts/audit-fees-vs-trace.mjs [sampleSize]
 *
 * Positions are chosen at RANDOM, not by size and not by whether they disagree
 * with anything. For each one the reference figure is the contract's own
 * `feesAccrued`, read from debug_traceTransaction and summed over the
 * position's whole life, then compared against the stored totalFeesCollected.
 *
 * The only thing taken from the indexer is WHICH BLOCKS to look in. The set of
 * modifies is re-derived from chain logs inside that window, and every fee
 * figure comes from the trace, so the indexer cannot validate itself.
 *
 * Progress is printed per position and per transaction, because a wide log
 * scan plus several traces can take a while and silence is indistinguishable
 * from a hang.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { decodeFunctionData, toFunctionSelector } from "viem";

const SAMPLE = Number(process.argv[2] ?? process.env.SAMPLE ?? 12);
const url = fs.readFileSync(".env", "utf8").split("\n")
  .find((l) => l.startsWith("ENVIO_AVALANCHE_RPC_URL")).split("=")[1].replace(/^"|"$/g, "");
const POOL_MANAGER = "0x06380c0e0912312b5150364b9dc4542ba0dbbc85";
const T_MODIFY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

const ABI = [{
  type: "function", name: "modifyLiquidity", stateMutability: "nonpayable",
  inputs: [
    { name: "key", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" }] },
    { name: "params", type: "tuple", components: [
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "liquidityDelta", type: "int256" }, { name: "salt", type: "bytes32" }] },
    { name: "hookData", type: "bytes" }],
  outputs: [{ name: "callerDelta", type: "int256" }, { name: "feesAccrued", type: "int256" }],
}];
const SEL = toFunctionSelector(ABI[0]);
const sx = (v) => { v &= (1n << 128n) - 1n; return v >= 1n << 127n ? v - (1n << 128n) : v; };
const abs = (v) => (v < 0n ? -v : v);
const hex = (n) => "0x" + n.toString(16);
const say = (s) => { process.stdout.write(s + "\n"); };
const step = (s) => { process.stdout.write(`\r    ${s.padEnd(72)}`); };

async function rpc(method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(45000) });
      const j = await r.json();
      if (j.error && /limit|429|too many/i.test(j.error.message || "")) throw new Error("rl");
      return j;
    } catch { await new Promise((r) => setTimeout(r, 700 * (a + 1))); }
  }
  return { error: { message: "retries exhausted" } };
}

/*
 * Window comes from the position's own ModifyLiquidity rows, NOT updatedAtBlock.
 * updatedAtBlock is bumped by the FeeSync refresh to near chain head, so using
 * it made the "lifetime window" the entire chain for every active position.
 */
const rows = execFileSync("docker", ["exec", "envio-postgres", "psql", "-U", "postgres",
  "-d", "envio-dev", "-t", "-A", "-F", "\t", "-c",
  `select p."tokenId", replace(p.pool,'43114_',''), t0.decimals, t1.decimals,
          p."totalFeesCollected0", p."totalFeesCollected1", p."feeBaselineValid",
          x.lo, x.hi, x.n
   from avalanche."Position" p
   join avalanche."Pool" pl on pl.id = p.pool
   join avalanche."Token" t0 on t0.id = pl.token0
   join avalanche."Token" t1 on t1.id = pl.token1
   join (select "tokenId", min("blockNumber") lo, max("blockNumber") hi, count(*) n
         from avalanche."PositionTransaction" group by "tokenId") x on x."tokenId" = p."tokenId"
   where p."isPriceable" ${process.env.FILTER ? "and (" + process.env.FILTER + ")" : ""}
   order by random() limit ${SAMPLE};`],
  { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n").filter((l) => l.trim()).map((l) => {
    const f = l.split("\t");
    return { tokenId: f[0], poolId: f[1], d0: +f[2], d1: +f[3],
      envio0: +f[4], envio1: +f[5], baselineValid: f[6] === "t",
      lo: Number(f[7]), hi: Number(f[8]), rowCount: Number(f[9]) };
  });

say(`Auditing ${rows.length} randomly selected positions against debug_traceTransaction.\n`);

function collect(node, acc) {
  if (node && typeof node.to === "string" && node.to.toLowerCase() === POOL_MANAGER &&
      typeof node.input === "string" && node.input.toLowerCase().startsWith(SEL) &&
      typeof node.output === "string" && node.output.length >= 2 + 128) acc.push(node);
  for (const c of node?.calls ?? []) collect(c, acc);
}

async function poolLogs(poolId, from, to, depth = 0) {
  const r = await rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to),
    address: POOL_MANAGER, topics: [T_MODIFY, poolId] }]);
  if (r.error || (r.result?.length ?? 0) >= 9999) {
    if (from >= to || depth > 14) return [];
    const mid = Math.floor((from + to) / 2);
    return [...(await poolLogs(poolId, from, mid, depth + 1)),
            ...(await poolLogs(poolId, mid + 1, to, depth + 1))];
  }
  return r.result ?? [];
}

let exact = 0, mismatch = 0, unverifiable = 0;
const problems = [];

for (let i = 0; i < rows.length; i++) {
  const p = rows[i];
  const lo = Math.max(0, p.lo - 2), hi = p.hi + 2;
  say(`[${i + 1}/${rows.length}] tokenId ${p.tokenId}  blocks ${lo}-${hi} (${(hi - lo).toLocaleString("en-US")})  indexer rows: ${p.rowCount}`);

  step("scanning chain logs for this pool/window...");
  const logs = await poolLogs(p.poolId, lo, hi);
  const mine = logs.filter((l) => {
    const d = l.data.slice(2);
    return d.length >= 256 && BigInt("0x" + d.slice(192, 256)) === BigInt(p.tokenId);
  });
  const txs = [...new Set(mine.map((l) => l.transactionHash))];
  step(`found ${mine.length} on-chain modifies in ${txs.length} txs; tracing...`);

  let t0 = 0, t1 = 0, traced = 0, failed = 0;
  for (let k = 0; k < txs.length; k++) {
    step(`tracing ${k + 1}/${txs.length}...`);
    const t = await rpc("debug_traceTransaction", [txs[k], { tracer: "callTracer" }]);
    if (t.error || !t.result) { failed++; continue; }
    const calls = []; collect(t.result, calls);
    let hit = false;
    for (const c of calls) {
      let salt;
      try { salt = BigInt(decodeFunctionData({ abi: ABI, data: c.input }).args[1].salt); }
      catch { continue; }
      if (salt !== BigInt(p.tokenId)) continue;
      const u = BigInt("0x" + c.output.slice(66, 130));
      t0 += Number(abs(sx(u >> 128n))) / 10 ** p.d0;
      t1 += Number(abs(sx(u & ((1n << 128n) - 1n)))) / 10 ** p.d1;
      hit = true;
    }
    if (hit) traced++; else failed++;
  }

  const rel = (a, b) => { const m = Math.max(Math.abs(a), Math.abs(b));
    return m === 0 ? 0 : Math.abs(a - b) / m; };
  const r0 = rel(t0, p.envio0), r1 = rel(t1, p.envio1);
  // token0 and token1 are compared SEPARATELY and never summed, so a crossed
  // fee0/fee1 mapping cannot cancel out. Asymmetry is asserted too: if the
  // contract paid in only one token, the indexer must agree on WHICH one.
  const shape = (a, b) => (a > 0 ? "0" : "") + (b > 0 ? "1" : "") || "none";
  const shapeOk = shape(t0, t1) === shape(p.envio0, p.envio1);
  const ok = r0 < 1e-6 && r1 < 1e-6 && shapeOk;
  if (!shapeOk) say(`    !! TOKEN SIDE DIFFERS: trace paid in [${shape(t0,t1)}], indexer says [${shape(p.envio0,p.envio1)}]`);

  process.stdout.write("\r" + " ".repeat(78) + "\r");
  if (ok) { exact++; say(`    EXACT   traced ${traced}/${txs.length}   fee0=${t0.toPrecision(8)} fee1=${t1.toPrecision(8)}`); }
  else if (failed > 0) { unverifiable++; say(`    UNVERIFIABLE  ${failed} of ${txs.length} txs could not be traced`); }
  else {
    mismatch++; problems.push({ ...p, t0, t1, r0, r1, txs: txs.length });
    say(`    MISMATCH  envio=(${p.envio0.toPrecision(10)}, ${p.envio1.toPrecision(10)})`);
    say(`              trace=(${t0.toPrecision(10)}, ${t1.toPrecision(10)})  rel=${r0.toExponential(2)}/${r1.toExponential(2)}`);
  }
  say(`    running: ${exact} exact, ${mismatch} mismatch, ${unverifiable} unverifiable\n`);
}

say(`================ RESULT ================`);
say(`  exact match to the contract : ${exact} / ${rows.length}`);
say(`  mismatch                    : ${mismatch}`);
say(`  unverifiable (trace failed) : ${unverifiable}`);
for (const q of problems)
  say(`    tokenId ${q.tokenId} baselineValid=${q.baselineValid} txs=${q.txs} rel=${q.r0.toExponential(2)}/${q.r1.toExponential(2)}`);
