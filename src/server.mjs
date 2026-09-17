// HTTP server: static web/ + scan jobs.
//   POST /api/jobs {address} → {id}     GET /api/jobs/<id> → status/result

import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ingestWallet, envInt } from "./ingest.mjs";
import { buildReconciledReport } from "./reconcile.mjs";
import { rpcEndpoints } from "./rpc.mjs";

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
// every env number goes through envInt: an empty string or a typo ("5x", "1O00")
// parses to 0/NaN via bare Number(), silently switching budgets and caps off —
// a zeroed scan budget turns every interactive report into an instant empty
// "done", a NaN jobs cap lets the map grow without bound
const PORT = envInt(process.env.PORT, 8787);
const MAX_SCAN_TX = envInt(process.env.INGEST_MAX_SCAN_TX, 1500);
const TARGET_TRADES = envInt(process.env.INGEST_TARGET_TRADES, 30);
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** @type {Map<string, object>} */
const jobs = new Map();
const MAX_JOBS = envInt(process.env.MAX_JOBS, 500);

// finished-job retention is time-based, so a fast loop of cheap job creations
// (a cached featured address answers instantly) could grow the map for the
// whole 10-minute window. Under pressure the oldest finished jobs go first —
// but only after a grace window: a report must outlive its scan, so filling
// the map with fresh jobs cannot steal a just-finished result from its
// poller. When nothing is evictable the POST handler answers 503.
const JOB_EVICTION_GRACE_MS = envInt(process.env.JOB_EVICTION_GRACE_MS, 60_000);
function evictFinishedJobs() {
  for (const [id, j] of jobs) {
    if (jobs.size < MAX_JOBS) break;
    if ((j.status === "done" || j.status === "error") && j.finished && Date.now() - j.finished > JOB_EVICTION_GRACE_MS) jobs.delete(id);
  }
}

// finished jobs linger 10 minutes for polling, then make room for new ones;
// a scan stuck past 6 minutes (hung upstream fetch) is failed AND cancelled —
// marking it error without aborting would free the slot while the zombie scan
// keeps burning the shared RPC queue and its memory
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, j] of jobs) {
    if ((j.status === "done" || j.status === "error") && j.finished && j.finished < cutoff) jobs.delete(id);
    else if (j.status === "running" && Date.now() - j.started > 6 * 60 * 1000) {
      j.status = "error";
      j.error = "scan timed out";
      j.finished = Date.now();
      try { j.abort?.abort(new Error("scan timed out")); } catch {}
    }
  }
}, 60 * 1000).unref();

// the landing-page wallets are rescanned in the background so a first-time
// visitor gets a finished report instantly instead of waiting on public RPC
const precomputed = new Map(); // address -> job-shaped result
let featuredAddresses = [];

// one round at a time: a slow round (up to 15 min of RPC pacing per wallet)
// must not stack on top of the next 60-min tick — stacked rounds would starve
// interactive scans in the shared RPC queue and grow memory without bound
let precomputeBusy = false;
async function precomputeFeatured() {
  if (precomputeBusy) return console.error("[stockbasis] precompute round still running, skipping tick");
  precomputeBusy = true;
  try {
    const fresh = new Map();
    for (const address of featuredAddresses) {
      try {
        // landing-page wallets get the deep scan: no UI is waiting on them,
        // and full history means real cost basis instead of "unknown" rows.
        // PRECOMPUTE_RPC can point the background scans at unmetered mirrors
        // so rate-limited/paid endpoints stay reserved for interactive scans.
        const { trades, coverage, ambiguous, classifyFailed, transfers: tfs } = await ingestWallet(address, {
          rpcUrl: process.env.PRECOMPUTE_RPC,
          maxScanTx: 8000, targetStockTrades: 300, timeBudgetS: 900,
        });
        if (!trades.length) continue; // dead wallet: keep the previous good snapshot instead of an empty report
        // the balance calls of the reconciliation ride the same unmetered
        // mirror as the scan itself — leaving rpcUrl unset would drop every
        // featured wallet's getTokenAccountsByOwner onto the interactive
        // endpoint the comment above just promised to spare
        const { report, reconciled, reconcileFailed } = await buildReconciledReport(address, trades, { rpcUrl: process.env.PRECOMPUTE_RPC });
        fresh.set(address, { ...report, reconciled, reconcileFailed, classifyFailed, coverage, ambiguous, transfersCount: tfs.length });
      } catch (e) {
        // String() first: a broken featured entry (address undefined) must
        // not turn the error handler itself into a TypeError that kills the
        // round for every wallet after it
        console.error(`[stockbasis] precompute ${String(address).slice(0, 8)} failed: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
    // stale-but-good beats fresh-and-empty: only replace entries that rescanned
    for (const [addr, prev] of precomputed) if (!fresh.has(addr)) fresh.set(addr, prev);
    precomputed.clear();
    for (const [k, v] of fresh) precomputed.set(k, v);
  } finally {
    precomputeBusy = false;
  }
}

async function loadFeatured() {
  try {
    const entries = JSON.parse(await readFile(path.join(dataDir, "featured.json"), "utf8"));
    // validate up front and say WHICH entry is broken: one malformed record
    // must skip itself, not poison the whole hourly precompute round
    featuredAddresses = [];
    for (const f of entries ?? []) {
      if (typeof f?.address !== "string" || !ADDRESS_RE.test(f.address)) {
        console.error(`[stockbasis] featured entry rejected (bad address): ${JSON.stringify(f)?.slice(0, 80)}`);
        continue;
      }
      featuredAddresses.push(f.address);
    }
    precomputeFeatured();
    setInterval(precomputeFeatured, 60 * 60 * 1000).unref();
  } catch (e) {
    // a silent catch here reads as "no featured wallets" forever: the strip
    // keeps serving (it re-reads the file per request) while every hourly
    // precompute round quietly iterates an empty list
    console.error(`[stockbasis] featured load failed: ${String(e?.message ?? e).slice(0, 120)}`);
    featuredAddresses = [];
  }
}

function startJob(address) {
  for (const j of jobs.values()) {
    if (j.address === address && j.status === "running") return j; // identical scan already in flight
  }

  const job = { id: randomUUID(), address, status: "running", progress: 0, trades: 0, started: Date.now(), abort: null };

  const cached = precomputed.get(address);
  if (cached) {
    job.status = "done";
    job.result = cached;
    job.progress = cached.coverage?.scanned ?? 0;
    job.trades = (cached.rows ?? []).reduce((s, r) => s + r.trades, 0);
    job.phase = "done";
    job.finished = Date.now();
    jobs.set(job.id, job);
    return job;
  }
  jobs.set(job.id, job);

  const ac = new AbortController();
  job.abort = ac;
  ingestWallet(address, {
    maxScanTx: MAX_SCAN_TX,
    targetStockTrades: TARGET_TRADES,
    signal: ac.signal,
    onWalk: (n) => { if (job.status === "running") { job.progress = n; job.phase = "history"; } },
    onProgress: (p) => { if (job.status === "running") { job.progress = p.scanned; job.trades = p.trades; job.phase = "scan"; } },
  })
    .then(async ({ trades, coverage, ambiguous, classifyFailed, transfers: tfs }) => {
      // a timed-out job must not resurrect: if the sweeper already answered
      // the poller with an error, the late result is discarded
      if (job.status !== "running") return;
      const { report, reconciled, reconcileFailed } = await buildReconciledReport(address, trades, { signal: ac.signal });
      if (job.status !== "running") return; // the sweeper may fire mid-report too
      job.result = { ...report, reconciled, reconcileFailed, classifyFailed, coverage, ambiguous, transfersCount: tfs.length };
      job.status = "done";
      job.finished = Date.now();
    })
    .catch((e) => {
      if (job.status !== "running") return; // the sweeper already reported this one
      job.status = "error";
      job.error = String(e?.message ?? e);
      job.finished = Date.now();
    });

  return job;
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    let body = "";
    // slow-body (slowloris) guard: the whole 1KB body must arrive in 15s
    const bodyTimer = setTimeout(() => { try { req.destroy(); } catch {} }, 15_000);
    let aborted = false;
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) {
          clearTimeout(bodyTimer);
          aborted = true;
          const out = json(res, 413, { error: "payload too large" });
          req.destroy(); // then stop the stream
          return out;
        }
      }
    } catch {
      aborted = true; // client vanished mid-body
    } finally {
      clearTimeout(bodyTimer);
    }
    if (aborted) return;
    // cross-site callers never legitimately reach this API: a plain form or
    // no-cors fetch (both send non-JSON content types) must not create scan
    // jobs from an attacker's page — require the JSON content type and a
    // same-origin fetch-metadata header when the browser sends one
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return json(res, 403, { error: "cross-site requests are not accepted" });
    const ctype = String(req.headers["content-type"] ?? "");
    if (!ctype.toLowerCase().startsWith("application/json")) return json(res, 415, { error: "application/json required" });
    let address;
    try { address = JSON.parse(body).address; } catch { /* handled below */ }
    if (!ADDRESS_RE.test(address ?? "")) return json(res, 400, { error: "valid Solana address required" });
    const runningNow = [...jobs.values()].filter((j) => j.status === "running").length;
    if (runningNow >= 20) return json(res, 503, { error: "server busy, try again shortly" });
    evictFinishedJobs();
    if (jobs.size >= MAX_JOBS) return json(res, 503, { error: "server busy, try again shortly" });
    const job = startJob(address);
    return json(res, 202, { id: job.id, target: TARGET_TRADES });
  }

  // HEAD answers the API routes exactly like GET minus the body
  const apiGet = req.method === "GET" || req.method === "HEAD";
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (apiGet && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: "no such job" });
    const { id, address, status, progress, trades, phase, error, result } = job;
    return json(res, 200, { id, address, status, progress, trades, phase, target: TARGET_TRADES, error, result });
  }

  if (apiGet && url.pathname === "/api/featured") {
    try {
      const featured = JSON.parse(await readFile(path.join(dataDir, "featured.json"), "utf8"));
      // the client renders whatever lands here, so gate it exactly like the
      // precompute leg (loadFeatured): a malformed record must not TypeError
      // the featured strip on every visitor's page load
      const clean = (Array.isArray(featured) ? featured : []).filter((f) => typeof f?.address === "string" && ADDRESS_RE.test(f.address));
      return json(res, 200, clean);
    } catch {
      return json(res, 200, []);
    }
  }

  if (apiGet && url.pathname === "/api/stats") {
    return json(res, 200, await marketStats());
  }

  if (apiGet) {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = path.normalize(path.join(webDir, file));
    if (target !== webDir && !target.startsWith(webDir + path.sep)) return json(res, 403, { error: "forbidden" });
    try {
      const data = await readFile(target);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(target)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  json(res, 405, { error: "method not allowed" });
  } catch {
    // client disconnected mid-request (ECONNRESET) — drop it, keep serving
    try { req.destroy(); res.destroy(); } catch {}
  }
});

function json(res, code, body) {
  // no-store: a stale proxy in front of the app must not answer a job poll
  // with a cached "running" body forever — the poll loop trusts these bodies
  // to describe a live job
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  // HEAD must behave like GET minus the body: a 404 on a live API route
  // tells uptime probes the service is dead when it is not
  res.end(res.req?.method === "HEAD" ? undefined : JSON.stringify(body));
}

// 24h volume across the tracked tokenized-equity pools, via DexScreener.
// One batched call per cache window; keeps the landing strip honest and live.
let statsCache = null; // { at, data, empty }
let statsInflight = null;
const STATS_TTL_MS = 10 * 60 * 1000;
// an empty strip is worth little time: a throttled burst must not freeze the
// volume line for the whole 10-minute window
const STATS_EMPTY_TTL_MS = envInt(process.env.STATS_EMPTY_TTL_MS, 60 * 1000);

async function marketStats() {
  if (statsCache && Date.now() - statsCache.at < (statsCache.empty ? STATS_EMPTY_TTL_MS : STATS_TTL_MS)) return statsCache.data;
  // single-flight: a landing-page burst at cache expiry shares one upstream
  // call instead of amplifying itself into the provider's rate limit
  if (statsInflight) return statsInflight;
  statsInflight = computeMarketStats().finally(() => { statsInflight = null; });
  return statsInflight;
}

async function computeMarketStats() {

  // an unreadable stocks.json must degrade to an empty strip, not destroy the
  // response socket (the read sits outside the network try below)
  let stocks = {};
  try { stocks = JSON.parse(await readFile(path.join(dataDir, "stocks.json"), "utf8")); } catch { /* empty strip */ }
  const mints = Object.keys(stocks);
  const out = { volume24hUsd: 0, trackedTokens: mints.length, tokensWithPools: 0, top: [] };

  try {
    if (mints.length) {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const pairs = await res.json();
      const bestPerMint = new Map();
      for (const p of pairs ?? []) {
        const base = p.baseToken?.address;
        // hasOwn: "__proto__"/"constructor" pass a plain [] lookup through the
        // prototype chain and would enter the strip as untracked phantoms
        if (!base || !Object.hasOwn(stocks, base)) continue;
        const vol = Number(p.volume?.h24);
        // one malformed field must not poison the whole aggregation (0 + "lots" -> NaN)
        if (!Number.isFinite(vol)) continue;
        const liq = p.liquidity?.usd ?? 0;
        if (!bestPerMint.has(base) || liq > bestPerMint.get(base).liq) bestPerMint.set(base, { p, vol, liq });
      }
      for (const [mint, { p, vol }] of bestPerMint) {
        out.volume24hUsd += vol;
        out.top.push({ symbol: stocks[mint].symbol, volumeUsdUsd: vol, priceUsd: p.priceUsd });
      }
      out.tokensWithPools = out.top.length;
      out.volume24hUsd = Math.round(out.volume24hUsd);
      // sort by the field actually stored above — a mistyped key makes the
      // comparator return NaN, the sort a no-op, and the "top" list just the
      // provider's response order with the real leader sliced off
      out.top.sort((a, b) => b.volumeUsdUsd - a.volumeUsdUsd);
      out.top = out.top.slice(0, 5);
    }
    }
  } catch {
    // stale or empty strip beats a broken page
  }
  // any empty strip gets the short TTL: a DexScreener miss AND an empty
  // universe file are both "degraded now, retry soon" — neither deserves the
  // full ten-minute window
  statsCache = { at: Date.now(), data: out, empty: out.tokensWithPools === 0 };
  return out;
}

// last-resort net: a single weird event must never kill the demo process
process.on("uncaughtException", (e) => console.error("[stockbasis] swallowed:", String(e).slice(0, 120)));
process.on("unhandledRejection", (e) => console.error("[stockbasis] swallowed rejection:", String(e).slice(0, 120)));

// bound how long a client may take to send its (tiny) request body
server.requestTimeout = 30_000;
server.headersTimeout = 31_000;

server.listen(PORT, () => {
  console.log(`[stockbasis] http://localhost:${PORT} (scan budget: ${MAX_SCAN_TX} txs or ${TARGET_TRADES} stock trades)`);
  // an empty balance answer can only be cross-checked when a second mirror
  // exists — a single-endpoint setup silently weakens reconciliation
  const lists = [["interactive", rpcEndpoints()]];
  if (process.env.PRECOMPUTE_RPC) lists.push(["precompute", rpcEndpoints({ rpcUrl: process.env.PRECOMPUTE_RPC })]);
  const warned = new Set();
  for (const [label, { current, others }] of lists) {
    if (current && !others.length && !warned.has(current)) {
      warned.add(current);
      console.error(`[stockbasis] WARNING: single RPC endpoint for ${label} scans (${current}) — empty-balance cross-check disabled`);
    }
  }
});
// STOCKBASIS_NO_FEATURED=1 skips the background precompute (tests/offline runs)
if (process.env.STOCKBASIS_NO_FEATURED !== "1") loadFeatured();
