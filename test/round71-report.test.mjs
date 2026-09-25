// Regression tests for polish round 71, disclosure zone (ingest gate + report
// counters + web/cli consumers). Every test pins one confirmed vector:
//   ingest: a recent full market reprice in the sanity gate clears the stale
//           partialCash/unpricedReason flags — the trade is valued in full,
//           so "P&L understated" must not keep claiming otherwise (SB20)
//   report: a fully unpriced ancient movement (valueUsd 0, lots consumed with
//           no proceeds) gets its own disclosure counter — the silent P&L hole
//           becomes visible without touching the round70 partialCash pin (SB27)
//   report: the partial-cash channel never inflates the unpriced-movement
//           counter — the two disclosure channels stay disjoint (SB27)
//   app:    a partial-cash note on ancient legs names the permanent 365-day
//           window instead of promising a rescan can help (SB23)
//   app:    the transient partial-cash note keeps its wording (round10 pin)
//   app:    fully unpriced movements render their own note (SB27)
//   cli:    the terminal summary surfaces unpriced movements and single-mirror
//           trusted zeros (SB27, SB22 — unpricedReason/singleSource consumers)

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no live metadata calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const { pairTrades, applySanityGate, WSOL } = await import("../src/ingest.mjs");
const { buildReport } = await import("../src/report.mjs");
const { primeSolDayCache } = await import("../src/price.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");

primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });

// offline determinism: CoinGecko never answers from the network here
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) {
    return Promise.resolve({ ok: false, status: 401, json: async () => ({ status: "error", error_code: 10012 }) });
  }
  return realFetch(u, o);
};
const now = Math.floor(Date.now() / 1000);
const ANCIENT_A = now - 400 * 86400; // beyond CoinGecko's public 365-day window

after(() => {
  globalThis.fetch = realFetch;
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
});

// ---- ingest: the recent reprice owns the whole valuation (SB20) ---------------

test("sanity gate: a recent full reprice clears the stale partial-cash disclosure", async () => {
  // a sell whose WSOL leg was unpriced at scan time books partialCash; two
  // days later the gate reprices it at FULL market value — the stale flags
  // must not outlive the trade they described (the report would keep saying
  // "P&L understated" for a trade now valued in full)
  const t = { side: "sell", mint: TSLAX, qty: 1, valueUsd: 100, ts: now - 2 * 86400, slot: 1, signature: "r71g", partialCash: true, unpricedReason: "ancient" };
  const { corrected } = applySanityGate([t], new Map([[TSLAX, 500]]), now);
  assert.equal(corrected, 1, "precondition: the trade took the recent-reprice branch");
  assert.equal(t.valueUsd, 500, "the trade is valued in full at market");
  assert.equal(t.priceCorrected, true);
  assert.equal(t.partialCash, undefined, "a fully valued trade has nothing understated — the stale flag must go");
  assert.equal(t.unpricedReason, undefined, "no unpriced leg survives the reprice");

  const report = await buildReport([t]);
  assert.equal(report.partialCash, 0, "the report must stop claiming 'P&L understated' for this trade");
  assert.equal(report.priceCorrections, 1, "the reprice still counts as a correction");
});

// ---- report: fully unpriced ancient movements get a counter (SB27) ------------

test("report: an ancient fully-unpriced sale discloses itself as an unpriced movement", async () => {
  // an ancient all-WSOL sell: nothing priced, the shares still leave the
  // inventory and consume FIFO lots with no proceeds and no P&L — the exact
  // hole no counter disclosed before (the WSOL leg arrives: cash of the sale)
  primeSolDayCache(ANCIENT_A, null);
  const trades = [];
  const transfers = [];
  await pairTrades(
    [{ mint: TSLAX, delta: -1 }, { mint: WSOL, delta: 0.5 }],
    { ts: ANCIENT_A, slot: 1, signature: "r71u", solDelta: 0, closedAta: 0 },
    trades,
    transfers,
  );
  const mv = trades.find((t) => t.side === "out");
  assert.ok(mv, "precondition: the shares still book as a movement");
  assert.equal(mv?.valueUsd, 0, "nothing was priced: no proceeds");
  assert.equal(mv?.unpricedReason, "ancient", "precondition: the movement names the permanent cause");

  const report = await buildReport(trades);
  assert.equal(report.unpricedMovements, 1, "the silent P&L hole must have a disclosure counter");
  assert.equal(report.partialCash, 0, "a movement has no proceeds to understate — no partial flag");
});

test("report: the partial-cash channel never inflates the unpriced-movement counter", async () => {
  // pins the channel split: ancient partial legs ride partialCash exactly as
  // round70 pinned ("no separate counter needed" for THAT channel); the new
  // counter counts only FULLY unpriced movements — no double disclosure
  const t = { side: "buy", mint: TSLAX, qty: 1, valueUsd: 180, ts: ANCIENT_A, slot: 1, signature: "r71pin", partialCash: true, unpricedReason: "ancient" };
  const report = await buildReport([t]);
  assert.equal(report.partialCash, 1, "round70 pin: ancient partial legs keep the understated counter");
  assert.equal(report.unpricedMovements, 0, "the movement counter is the other channel — no double counting");

  const clean = await buildReport([{ side: "sell", mint: TSLAX, qty: 1, valueUsd: 180, ts: now - 10, slot: 1, signature: "r71c" }]);
  assert.equal(clean.unpricedMovements, 0, "a cleanly priced trade flags nothing");
});

// ---- web/app.js (DOM sandbox) --------------------------------------------------

const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const runApp = (fetchImpl) => {
  const els = {};
  const el = (id) => els[id] ??= {
    hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {},
    listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); },
  };
  for (const id of ["featured", "featured-list", "market", "scan", "address", "go", "progress", "progress-text", "bar-fill", "error", "report", "total", "total-sub", "assume", "assume-opt", "basis-note", "drows", "dnote", "dtable", "rows", "csv"]) el(id);
  const sandbox = {
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      createElement: () => ({ href: "", download: "", click() {} }),
    },
    fetch: fetchImpl,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {},
    console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite,
    setTimeout, clearTimeout, AbortSignal, Intl,
  };
  vm.runInNewContext(appCode, sandbox);
  return { els };
};
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const doneJob = (extra = {}) => ({
  id: "j1", address: OWNER, status: "done", progress: 1, trades: 1, phase: "done", error: null,
  result: {
    rows: [{ mint: TSLAX, symbol: "TSLAx", name: "", trades: 1, buys: 1, sells: 0, wins: 1, losses: 0, unknownBasis: 0, realizedUsd: 100, realizedAssumed: 0, openQty: 1, openUnknownQty: 0, openCostUsd: 10, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }],
    totalRealized: 100, totalAssumed: 0, tokens: 1, unknownBasis: 0, coverage: null, disposals: [],
    ...extra,
  },
});
const scanJob = async (els) => {
  els.address.value = OWNER;
  els.scan.requestSubmit();
  for (let i = 0; i < 100 && els.report.hidden; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(els.report.hidden, false, "precondition: the report rendered");
  return els["basis-note"].textContent;
};
const jobFetcher = (extra) => (url, opts) => {
  if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
  if (String(url).includes("/api/jobs/")) return jsonRes(doneJob(extra));
  return jsonRes([]);
};

test("app: an ancient partial-cash note names the permanent window, not a scan-time outage", async () => {
  const { els } = runApp(jobFetcher({ partialCash: 1, partialCashAncient: 1 }));
  const note = await scanJob(els);
  assert.match(note, /outside the 365-day price window/, `the ancient cause must be named (got "${note}")`);
  assert.match(note, /rescan/, "the note must say a rescan cannot recover the price");
  assert.doesNotMatch(note, /unavailable at scan time/, "the transient story must not cover ancient days");
});

test("app: a transient partial-cash note keeps the scan-time wording (round10 pin)", async () => {
  const { els } = runApp(jobFetcher({ partialCash: 2 }));
  const note = await scanJob(els);
  assert.match(note, /stablecoin leg only/, "the round10 disclosure wording survives");
  assert.match(note, /unavailable at scan time/, "a transient outage keeps its story");
  assert.doesNotMatch(note, /365-day/, "no ancient claim on a transient outage");
});

test("app: fully unpriced movements get their own disclosure note", async () => {
  const { els } = runApp(jobFetcher({ unpricedMovements: 2 }));
  const note = await scanJob(els);
  assert.match(note, /2 movements unpriced/, `the hole must be disclosed (got "${note}")`);
  assert.match(note, /incomplete/, "the note must say realized P&L may be incomplete");
});

// ---- cli: the terminal summary surfaces the new disclosures (SB27, SB22) -------

const servers = [];
const children = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const out = handler(msg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out.result }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const runCli = async (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, RPC_MAX_RETRIES: "2", RPC_MIN_INTERVAL_MS: "0", STOCKBASIS_NO_MARKET: "1", ...env },
  });
  children.push(child);
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.on("close", (code) => resolve({ code, out, err }));
});
const tb = (accountIndex, mint, owner, amount) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });

test("cli: an ancient unpriced sale surfaces in the terminal summary", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: ANCIENT_A, err: null }] };
    if (msg.method === "getTransaction") {
      return { result: {
        transaction: { message: { accountKeys: [{ pubkey: OWNER }] } },
        meta: {
          preTokenBalances: [tb(1, TSLAX, OWNER, 1), tb(2, WSOL, OWNER, 0)],
          postTokenBalances: [tb(1, TSLAX, OWNER, 0), tb(2, WSOL, OWNER, 0.5)],
          preBalances: [1e9], postBalances: [1e9], fee: 5000,
        },
      } };
    }
    return { result: { value: [] } }; // balance reads answer nothing
  });
  const r = await runCli(["src/cli.mjs", "report", OWNER], { SOLANA_RPC: stub.url });
  assert.equal(r.code, 0, `exit 0 (stderr: ${r.err.slice(0, 300)})`);
  assert.match(r.out, /1 movement/, `the unpriced movement must be counted (stdout: ${r.out.slice(0, 500)})`);
  assert.match(r.out, /unpriced/, "the line must name the hole");
});

test("cli: a single-mirror trusted zero is disclosed in the terminal summary", { timeout: 30_000 }, async () => {
  // one endpoint serves an empty balance answer for a claimed position: the
  // zero is trusted (single-endpoint setup) but must be disclosed as such
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: 1_700_000_000, err: null }] };
    if (msg.method === "getTransaction") {
      return { result: {
        transaction: { message: { accountKeys: [{ pubkey: OWNER }] } },
        meta: {
          preTokenBalances: [tb(2, USDC, OWNER, 1000)],
          postTokenBalances: [tb(1, TSLAX, OWNER, 5), tb(2, USDC, OWNER, 500)],
          preBalances: [1e9], postBalances: [1e9], fee: 5000,
        },
      } };
    }
    return { result: { value: [] } }; // "you hold nothing" — one mirror's word
  });
  const r = await runCli(["src/cli.mjs", "report", OWNER], { SOLANA_RPC: stub.url });
  assert.equal(r.code, 0, `exit 0 (stderr: ${r.err.slice(0, 300)})`);
  assert.match(r.out, /singleSource/, `the table must carry the flag (stdout: ${r.out.slice(0, 500)})`);
  assert.match(r.out, /ONE RPC mirror/, `the summary must disclose the one-mirror trust (stdout: ${r.out.slice(0, 500)})`);
});
