// HTTP server: static web/ + scan jobs.
//   POST /api/jobs {address} → {id}     GET /api/jobs/<id> → status/result

import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ingestWallet } from "./ingest.mjs";
import { buildReport } from "./report.mjs";

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const PORT = Number(process.env.PORT ?? 8787);
const MAX_SCAN_TX = Number(process.env.INGEST_MAX_SCAN_TX ?? 1500);
const TARGET_TRADES = Number(process.env.INGEST_TARGET_TRADES ?? 30);
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** @type {Map<string, object>} */
const jobs = new Map();

// finished jobs linger 10 minutes for polling, then make room for new ones;
// a scan stuck past 6 minutes (hung upstream fetch) is failed as well
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, j] of jobs) {
    if ((j.status === "done" || j.status === "error") && j.finished && j.finished < cutoff) jobs.delete(id);
    else if (j.status === "running" && Date.now() - j.started > 6 * 60 * 1000) {
      j.status = "error";
      j.error = "scan timed out";
      j.finished = Date.now();
    }
  }
}, 60 * 1000).unref();

// the landing-page wallets are rescanned in the background so a first-time
// visitor gets a finished report instantly instead of waiting on public RPC
const precomputed = new Map(); // address -> job-shaped result
let featuredAddresses = [];

async function precomputeFeatured() {
  for (const address of featuredAddresses) {
    try {
      // landing-page wallets get the deep scan: no UI is waiting on them,
      // and full history means real cost basis instead of "unknown" rows
      const { trades, coverage, ambiguous } = await ingestWallet(address, { maxScanTx: 8000, targetStockTrades: 300, timeBudgetS: 900 });
      precomputed.set(address, { ...(await buildReport(trades)), coverage, ambiguous });
    } catch (e) {
      console.error(`[stockbasis] precompute ${address.slice(0, 8)} failed: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
}

async function loadFeatured() {
  try {
    featuredAddresses = (JSON.parse(await readFile(path.join(dataDir, "featured.json"), "utf8"))).map((f) => f.address);
    precomputeFeatured();
    setInterval(precomputeFeatured, 60 * 60 * 1000).unref();
  } catch {
    featuredAddresses = [];
  }
}

function startJob(address) {
  for (const j of jobs.values()) {
    if (j.address === address && j.status === "running") return j; // identical scan already in flight
  }

  const job = { id: randomUUID(), address, status: "running", progress: 0, trades: 0, started: Date.now() };

  const cached = precomputed.get(address);
  if (cached) {
    job.status = "done";
    job.result = cached;
    job.finished = Date.now();
    jobs.set(job.id, job);
    return job;
  }
  jobs.set(job.id, job);

  ingestWallet(address, {
    maxScanTx: MAX_SCAN_TX,
    targetStockTrades: TARGET_TRADES,
    onWalk: (n) => { job.progress = n; job.phase = "history"; },
    onProgress: (p) => { job.progress = p.scanned; job.trades = p.trades; job.phase = "scan"; },
  })
    .then(async ({ trades, coverage, ambiguous }) => {
      job.result = { ...(await buildReport(trades)), coverage, ambiguous };
      job.status = "done";
      job.finished = Date.now();
    })
    .catch((e) => {
      job.status = "error";
      job.error = String(e?.message ?? e);
      job.finished = Date.now();
    });

  return job;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) {
        req.destroy(); // stop the stream before it can push more
        return json(res, 413, { error: "payload too large" });
      }
    }
    let address;
    try { address = JSON.parse(body).address; } catch { /* handled below */ }
    if (!ADDRESS_RE.test(address ?? "")) return json(res, 400, { error: "valid Solana address required" });
    if (jobs.size > 20) return json(res, 503, { error: "server busy, try again shortly" });
    const job = startJob(address);
    return json(res, 202, { id: job.id });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: "no such job" });
    const { id, address, status, progress, trades, phase, error, result } = job;
    return json(res, 200, { id, address, status, progress, trades, phase, error, result });
  }

  if (req.method === "GET" && url.pathname === "/api/featured") {
    try {
      const featured = JSON.parse(await readFile(path.join(dataDir, "featured.json"), "utf8"));
      return json(res, 200, featured);
    } catch {
      return json(res, 200, []);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    return json(res, 200, await marketStats());
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = path.normalize(path.join(webDir, file));
    if (!target.startsWith(webDir)) return json(res, 403, { error: "forbidden" });
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
});

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// 24h volume across the tracked tokenized-equity pools, via DexScreener.
// One batched call per cache window; keeps the landing strip honest and live.
let statsCache = null;
async function marketStats() {
  if (statsCache && Date.now() - statsCache.at < 10 * 60 * 1000) return statsCache.data;

  const stocks = JSON.parse(await readFile(path.join(dataDir, "stocks.json"), "utf8"));
  const mints = Object.keys(stocks);
  const out = { volume24hUsd: 0, trackedTokens: mints.length, tokensWithPools: 0, top: [] };

  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`);
    if (res.ok) {
      const pairs = await res.json();
      const bestPerMint = new Map();
      for (const p of pairs ?? []) {
        const base = p.baseToken?.address;
        if (!stocks[base]) continue;
        if (!bestPerMint.has(base) || (p.liquidity?.usd ?? 0) > (bestPerMint.get(base).liquidity?.usd ?? 0)) bestPerMint.set(base, p);
      }
      for (const [mint, p] of bestPerMint) {
        out.volume24hUsd += p.volume?.h24 ?? 0;
        out.top.push({ symbol: stocks[mint].symbol, volume24hUsd: p.volume?.h24 ?? 0, priceUsd: p.priceUsd });
      }
      out.tokensWithPools = out.top.length;
      out.volume24hUsd = Math.round(out.volume24hUsd);
      out.top.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
      out.top = out.top.slice(0, 5);
    }
  } catch {
    // stale or empty strip beats a broken page
  }
  statsCache = { at: Date.now(), data: out };
  return out;
}

server.listen(PORT, () => console.log(`[stockbasis] http://localhost:${PORT} (scan budget: ${MAX_SCAN_TX} txs or ${TARGET_TRADES} stock trades)`));
loadFeatured();
