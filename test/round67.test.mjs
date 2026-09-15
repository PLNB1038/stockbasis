// Regression tests for polish rounds 6-7. Every test pins one proven vector:
//   rpc: a 200-OK without a JSON-RPC envelope must fail, not read as "empty"
//   rpc: 429 backoff and the -32020 rotation must not share one attempt cap
//   reconcile: null/garbage uiAmount and non-array answers must fail the read
//   reconcile: synthetic movements sort after the newest real trade
//   reconcile: an abort during the last balance call rejects the report
//   report: metadata lookups stop after an abort
//   basis: degenerate buys/deposits never poison the lot queues
//   basis: line items are cent atoms; totals equal the sum of CSV cells
//   basis: assumed P&L rides the statement as its own column
//   basis: nano open positions survive the summary round trip
//   ingest: env numbers fall back to defaults on typos and empty strings
//   csv: sub-milli quantities keep 9 decimals
//   server: HEAD answers API routes; POST demands JSON and same-origin
//   server: a broken featured entry cannot kill the precompute round
//   server: an empty universe strip gets the short cache TTL
//   server: the "top pools" strip is actually sorted by volume
//   app.js: stale reports/CSV cannot surface during a newer scan; a 404
//           poll fails fast with its own message

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls

const servers = [];
const children = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"), req, res);
      if (out === undefined) return; // handler wrote the response itself
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const waitReady = async (base, path_ = "/api/featured") => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + path_); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

// Jupiter stub: delays answers for SLOW-prefixed mints so an abort can land
// mid-loop; everything else answers instantly with an empty (no-data) list
const jupLog = [];
const jup = await stubServer((msg) => {
  const mint = String(msg?.params?.query ?? "");
  return {
    result: (() => {
      const at = Date.now();
      jupLog.push({ mint, at });
      if (mint.startsWith("SLOW")) { const t = Date.now(); while (Date.now() - t < 200) { /* spin */ } }
      return [];
    })(),
  };
});
process.env.JUP_SEARCH_URL = jup.url;

const { rpc } = await import("../src/rpc.mjs");
const { buildReconciledReport } = await import("../src/reconcile.mjs");
const { buildReport } = await import("../src/report.mjs");
const { fifoBasis, perStockSummary } = await import("../src/basis.mjs");
const { toCsv } = await import("../src/csv.mjs");
const { envInt } = await import("../src/ingest.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");
primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const c of children) c.kill("SIGKILL");
});

// ---- rpc -------------------------------------------------------------------

test("rpc: HTTP 200 without a JSON-RPC envelope fails honestly, never reads as empty success", async () => {
  const broken = await stubServer((msg, req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1 })); // neither result nor error
  });
  await assert.rejects(
    rpc("getSignaturesForAddress", [OWNER, { limit: 10 }], { rpcUrl: broken.url }),
    /without a JSON-RPC envelope/,
  );
});

test("rpc: a throttled mirror must not spend the -32020 rotation's budget and fake a confirmed hole", async () => {
  const hole = async () => ({ error: { code: -32020, message: "Transaction not found" } });
  const a = await stubServer(hole);
  const b = await stubServer((msg, req, res) => { res.writeHead(429); res.end(); });
  const c = await stubServer(hole);
  await assert.rejects(
    rpc("getTransaction", ["sig", {}], { rpcUrl: `${a.url},${b.url},${c.url}` }),
    (e) => !/-32020/.test(e.message) && /HTTP 429|rotation exhausted/.test(e.message),
  );
});

// ---- reconcile -------------------------------------------------------------

test("reconcile: a null uiAmount with a valid uiAmountString reads the real balance", async () => {
  const stub = await stubServer(() => ({
    result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: null, uiAmountString: "5" } } } } } }] },
  }));
  const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 1_700_000_000, slot: 1 }];
  const { report, reconciled, reconcileFailed } = await buildReconciledReport(OWNER, trades, { rpcUrl: stub.url });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.equal(reconciled, 0, "nothing to adjust when the chain agrees with the scan");
  assert.equal(reconcileFailed, 0);
  assert.ok(Math.abs(row.openQty - 5) < 1e-9, `position must survive (openQty=${row.openQty})`);
});

test("reconcile: a non-numeric balance with no fallback fails the read instead of wiping the position", async () => {
  const stub = await stubServer(() => ({
    result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: "garbage" } } } } } }] },
  }));
  const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 1_700_000_000, slot: 1 }];
  const { report, reconciled, reconcileFailed } = await buildReconciledReport(OWNER, trades, { rpcUrl: stub.url });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.equal(reconciled, 0);
  assert.equal(reconcileFailed, 1, "a garbage balance field is a failed read");
  assert.ok(Math.abs(row.openQty - 5) < 1e-9, `the scan result stands (openQty=${row.openQty})`);
});

test("reconcile: an empty-envelope confirm is not agreement with zero", async () => {
  const emptyMirror = await stubServer(() => ({ result: { value: [] } }));
  const garbageMirror = await stubServer((msg, req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })); // no value array
  });
  const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 1_700_000_000, slot: 1 }];
  const { report, reconciled, reconcileFailed } = await buildReconciledReport(OWNER, trades, {
    rpcUrl: `${emptyMirror.url},${garbageMirror.url}`,
  });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.equal(reconciled, 0, "zeroing positions requires two real answers");
  assert.equal(reconcileFailed, 1);
  assert.ok(Math.abs(row.openQty - 5) < 1e-9, `position must not be wiped "after verification" (openQty=${row.openQty})`);
});

test("reconcile: a lagging machine clock cannot reorder synthetic movements before real trades", async () => {
  const T = 1_700_000_000;
  const stub = await stubServer(() => ({
    result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 4, uiAmountString: "4" } } } } } }] },
  }));
  const trades = [
    { side: "buy", mint: TSLAX, qty: 4, valueUsd: 40, ts: T, slot: 1 },
    { side: "sell", mint: TSLAX, qty: 4, valueUsd: 110, ts: T + 600, slot: 2 },
  ];
  // wall clock a full hour BEHIND the newest chain time
  const { report } = await buildReconciledReport(OWNER, trades, { rpcUrl: stub.url, now: () => T - 3600 });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.ok(Math.abs(report.totalRealized - 70) < 1e-9, `the real close keeps its P&L (got ${report.totalRealized})`);
  assert.ok(Math.abs(row.openUnknownQty - 4) < 1e-9, "the unseen deposit lands after the sale as basis-less inventory");
});

test("reconcile: an abort during the final balance call rejects instead of resolving unreconciled", async () => {
  const stub = await stubServer(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { result: { value: [] } };
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("scan timed out")), 50);
  const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 1_700_000_000, slot: 1 }];
  await assert.rejects(buildReconciledReport(OWNER, trades, { rpcUrl: stub.url, signal: ac.signal }), /aborted/);
});

// ---- report ----------------------------------------------------------------

test("report: token-metadata lookups stop once the scan is aborted", async () => {
  const mints = ["SLOW1111111111111111111111111111111111111111", "SLOW2222222222222222222222222222222222222222", "SLOW3333333333333333333333333333333333333333"];
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(new Error("scan timed out")), 250);
  await buildReport(mints.map((mint, i) => ({ side: "buy", mint, qty: 1, valueUsd: 1, ts: 1 + i })), { signal: ac.signal });
  const after = jupLog.filter((e) => e.mint.startsWith("SLOW") && e.at > t0 + 250);
  assert.equal(after.length, 0, `no lookup may start after the abort (started ${after.length})`);
});

// ---- basis / csv -----------------------------------------------------------

test("basis: degenerate buys and deposits never poison the lot queues", () => {
  const r1 = fifoBasis([
    { side: "buy", qty: NaN, valueUsd: 100, ts: 1, slot: 1 },
    { side: "sell", qty: 1, valueUsd: 50, ts: 2, slot: 1 },
  ]);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(r1)), `NaN leaked into the payload: ${JSON.stringify(r1)}`);
  const r2 = fifoBasis([{ side: "in", qty: -5, ts: 1, slot: 1 }, { side: "sell", qty: 3, valueUsd: 30, ts: 2, slot: 1 }]);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(r2)), `negative deposit leaked: ${JSON.stringify(r2)}`);
  assert.equal(r2.unknownBasis.filter((u) => u.qty <= 0).length, 0, "no negative unknown entries");
  const r3 = fifoBasis([{ side: "buy", qty: -2, valueUsd: 100, ts: 1, slot: 1 }, { side: "sell", qty: 3, valueUsd: 30, ts: 2, slot: 1 }]);
  assert.equal(r3.closes.length, 0, "a negative buy is not inventory");
});

test("basis/csv: the grand total equals the sum of the CSV gain column", async () => {
  const M = "Mint11111111111111111111111111111111111111111";
  const T = 1_700_000_000;
  const report = await buildReport([
    { side: "buy", mint: M, qty: 1, valueUsd: 1.855, ts: T, slot: 1 },
    { side: "sell", mint: M, qty: 1, valueUsd: 2.0, ts: T + 10, slot: 2 },
    { side: "buy", mint: M, qty: 1, valueUsd: 1.855, ts: T + 20, slot: 3 },
    { side: "sell", mint: M, qty: 1, valueUsd: 2.0, ts: T + 30, slot: 4 },
  ]);
  const cells = toCsv(report.disposals).split("\n").slice(1).filter(Boolean).map((l) => Number(l.split(",")[7]));
  const csvSum = Math.round(cells.reduce((s, c) => s + c, 0) * 100) / 100;
  assert.equal(csvSum, report.totalRealized, `CSV cells sum to ${csvSum} but the report total is ${report.totalRealized}`);
});

test("basis/csv: an assumable unknown-basis disposal carries its assumed P&L into the CSV", () => {
  const T = 1_700_000_000;
  const b = fifoBasis([
    { side: "in", qty: 10, valueUsd: 0, ts: T, slot: 1 },
    { side: "sell", qty: 10, valueUsd: 5000, ts: T + 3600, slot: 2, marketPx: 400, marketPxAt: T + 7200 },
  ]);
  assert.ok(Math.abs(b.unknownBasis[0].pnlAssumedUsd - 1000) < 1e-9, `assumed pnl must be 1000 (got ${b.unknownBasis[0].pnlAssumedUsd})`);
  const line = toCsv(b.unknownBasis.map((u) => ({ symbol: "T", mint: "M", acquiredTs: null, ...u }))).split("\n")[1];
  assert.ok(line.endsWith(",1000.00"), `the assumed column must carry the value (got: ${line})`);
});

test("basis: a nano open position survives the summary round trip", () => {
  const M = "Mint11111111111111111111111111111111111111111";
  const row = perStockSummary(new Map([[M, [{ side: "buy", mint: M, qty: 9e-11, valueUsd: 1e-9, ts: 1_700_000_000, slot: 1 }]]]), () => ({ symbol: "T", name: "" }))[0];
  assert.ok(row.openQty > 0, `9e-11 is a real position of a 9-decimals mint, not a dash (got ${row.openQty})`);
});

test("csv: sub-milli quantities keep their real digits", () => {
  const row = (qty) => ({ symbol: "T", mint: "M", acquiredTs: 1, soldTs: 2, qty, proceedsUsd: 1, costUsd: 1, pnlUsd: 0 });
  assert.equal(toCsv([row(0.0000015)]).split("\n")[1].split(",")[4], "0.0000015");
  assert.equal(toCsv([row(123.4567895)]).split("\n")[1].split(",")[4], "123.456789"); // >= 1e-3 keeps 6 decimals
  assert.equal(toCsv([row(2e-7)]).split("\n")[1].split(",")[4], "0.0000002");
});

// ---- ingest env ------------------------------------------------------------

test("ingest: environment numbers fall back to defaults on typos and empty strings", () => {
  assert.equal(envInt("15O0", 1500), 1500, "a letter-o typo is not a budget");
  assert.equal(envInt("5,", 5), 5);
  assert.equal(envInt("", 1500), 1500, "an empty variable is not zero");
  assert.equal(envInt("   ", 5), 5);
  assert.equal(envInt("7", 5), 7);
  assert.equal(envInt(undefined, 5), 5);
});

// ---- server ----------------------------------------------------------------

const spawnServer = async (args, env) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  if (!(await waitReady(base))) throw new Error("server child did not come up");
  return { child, base };
};

test("server: HEAD answers the API routes like GET minus the body; POST demands JSON and same-origin", async () => {
  const { child, base } = await spawnServer(["src/server.mjs"], { STOCKBASIS_NO_FEATURED: "1" });
  try {
    const head = await fetch(base + "/api/featured", { method: "HEAD" });
    assert.equal(head.status, 200, "HEAD on a live API route must not read as 404");
    assert.equal((await head.text()).length, 0, "HEAD carries no body");
    const get = await fetch(base + "/api/featured");
    assert.equal(get.status, 200);

    const plain = await fetch(base + "/api/jobs", { method: "POST", body: '{"address":"' + OWNER + '"}', headers: { "Content-Type": "text/plain" } });
    assert.equal(plain.status, 415, "a form/no-cors cross-site POST must not create jobs");
    const cross = await fetch(base + "/api/jobs", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } });
    assert.equal(cross.status, 403, "cross-site JSON must be rejected before any job exists");
    const badAddr = await fetch(base + "/api/jobs", { method: "POST", body: '{"address":"nope"}', headers: { "Content-Type": "application/json" } });
    assert.equal(badAddr.status, 400, "same-origin JSON still reaches validation");
  } finally { child.kill("SIGKILL"); }
});

test("server: the stats strip is actually sorted — the volume leader cannot be sliced off", async () => {
  const { child, base } = await spawnServer([path.join("test", "fixtures", "stats-child.mjs")], { DS_MODE: "sort", STOCKBASIS_NO_FEATURED: "1" });
  try {
    const stats = await (await fetch(base + "/api/stats")).json();
    assert.equal(stats.top.length, 5);
    assert.equal(stats.top[0].volumeUsdUsd, 9_000_000, `the leader must rank first (got ${JSON.stringify(stats.top.map((t) => t.volumeUsdUsd))})`);
    for (let i = 1; i < stats.top.length; i++) {
      assert.ok(stats.top[i - 1].volumeUsdUsd >= stats.top[i].volumeUsdUsd, "volumes must be non-increasing");
    }
  } finally { child.kill("SIGKILL"); }
});

const tmpRepo = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-r67-"));
  for (const d of ["src", "web", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await cp(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
};

test("server: one broken featured entry cannot kill the precompute round", async () => {
  const dir = await tmpRepo();
  const realStocks = await readFile(path.join(ROOT, "data", "stocks.json"), "utf8");
  const A = "Baaa1111111111111111111111111111111111111111";
  const B = "Caaa1111111111111111111111111111111111111111";
  await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: A }, { label: "no address here" }, { address: B }]));

  const seen = new Set();
  const stub = await stubServer((msg) => {
    if (msg?.method === "getSignaturesForAddress") seen.add(msg.params[0]);
    return { result: [] };
  });

  const port = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), PRECOMPUTE_RPC: stub.url, RPC_MIN_INTERVAL_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  try {
    for (let i = 0; i < 100 && !(seen.has(A) && seen.has(B)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.has(B), `the round must reach the wallet after the broken entry (seen: ${[...seen]})`);
    assert.ok(/featured entry rejected/.test(stderr), "the operator gets told WHICH entry is broken");
    assert.ok(!/TypeError/.test(stderr), "the catch handler itself must not throw");
  } finally { child.kill("SIGKILL"); }
});

test("server: an empty universe strip recovers on the short TTL, not the full window", async () => {
  const dir = await tmpRepo();
  const realStocks = await readFile(path.join(ROOT, "data", "stocks.json"), "utf8");
  await writeFile(path.join(dir, "data", "stocks.json"), "{}");

  const port = 21000 + Math.floor(Math.random() * 20000);
  // prelude: fake the DexScreener upstream (reads the CURRENT universe file
  // per call, so the restored universe sees healthy data immediately)
  const prelude = `
    const real = globalThis.fetch;
    const { readFileSync } = require("node:fs");
    globalThis.fetch = (u, o) => {
      if (String(u).includes("api.dexscreener.com")) {
        const mints = Object.keys(JSON.parse(readFileSync("data/stocks.json", "utf8")));
        const pairs = mints.length ? [{ baseToken: { address: mints[0] }, priceUsd: 2.5, liquidity: { usd: 9000 }, volume: { h24: 12345 } }] : [];
        return Promise.resolve({ ok: true, json: async () => pairs });
      }
      return real(u, o);
    };
    process.env.STOCKBASIS_NO_FEATURED = "1";
    import("./src/server.mjs");
  `;
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", prelude], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), STATS_EMPTY_TTL_MS: "400" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/api/stats"); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    const degraded = await (await fetch(base + "/api/stats")).json();
    assert.equal(degraded.trackedTokens, 0, "precondition: the broken universe degrades the strip");
    await writeFile(path.join(dir, "data", "stocks.json"), realStocks);
    await new Promise((r) => setTimeout(r, 1200));
    const recovered = await (await fetch(base + "/api/stats")).json();
    assert.ok(recovered.trackedTokens > 0, `the fixed universe must recover within the short TTL (got ${recovered.trackedTokens})`);
  } finally { child.kill("SIGKILL"); }
});

// ---- web/app.js (DOM sandbox) ----------------------------------------------

const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const runApp = (fetchImpl) => {
  const els = {};
  const el = (id) => els[id] ??= {
    hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {},
    listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); },
  };
  // app.js only touches most ids inside handlers; create the full set up
  // front so tests can drive inputs before any render happened
  for (const id of ["featured", "featured-list", "market", "scan", "address", "go", "progress", "progress-text", "bar-fill", "error", "report", "total", "total-sub", "assume", "assume-opt", "basis-note", "drows", "dnote", "dtable", "rows", "csv"]) el(id);
  const blobs = [];
  const downloads = [];
  const sandbox = {
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      createElement: () => ({ href: "", download: "", click() { downloads.push(this.download); } }),
    },
    fetch: fetchImpl,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { blobs.push({ parts, opts }); } },
    console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite, Number,
    setTimeout, clearTimeout, AbortSignal, Intl,
  };
  vm.runInNewContext(appCode, sandbox);
  return { els, blobs, downloads };
};
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

const doneJob = (symbol) => ({
  id: "j1", address: OWNER, status: "done", progress: 1, trades: 1, phase: "done", error: null,
  result: {
    rows: [{ mint: "Mint11111111111111111111111111111111111111111", symbol, name: "", trades: 1, buys: 1, sells: 0, wins: 1, losses: 0, unknownBasis: 0, realizedUsd: 100, realizedAssumed: 0, openQty: 1, openUnknownQty: 0, openCostUsd: 10, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }],
    totalRealized: 100, totalAssumed: 0, tokens: 1, unknownBasis: 0, coverage: null,
    disposals: [{ symbol, mint: "Mint11111111111111111111111111111111111111111", acquiredTs: null, soldTs: 1, qty: 0.0000015, proceedsUsd: 1, costUsd: null, pnlUsd: null, pnlAssumedUsd: null }],
  },
});

test("app: a 404 poll fails fast with its own message, not six network retries", async () => {
  let gets = 0;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    if (String(url).includes("/api/jobs/")) gets++;
    return jsonRes({ error: "no such job" }, 404);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 300));
  assert.match(els.error.textContent, /Server restarted/);
  assert.equal(gets, 1, `a 404 is not a network blip — exactly one GET (made ${gets})`);
});

test("app: a stale report and its CSV cannot surface while a newer scan runs", async () => {
  let postId = 0;
  let phase = "running";
  const { els, blobs, downloads } = runApp((url, opts) => {
    if (opts?.method === "POST") { postId++; return jsonRes({ id: `j${postId}` }, 202); }
    if (url.endsWith("/j1")) return jsonRes(doneJob("FAKEX"));
    return phase === "done"
      ? jsonRes({ ...doneJob("REALY"), id: "j2" })
      : jsonRes({ id: "j2", status: phase, progress: 1, trades: 0, phase: "scan" });
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(els.report.hidden, false, "precondition: the first report rendered");

  // second scan starts; the first report's assume checkbox is still visible
  els.address.value = "Bbbb1111111111111111111111111111111111111111";
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(els.progress.hidden, false, "precondition: the second scan is running");
  assert.equal(els.report.hidden, true);

  els.assume.checked = true;
  els.assume.listeners.change();
  assert.equal(els.report.hidden, true, "the stale report must not render over the running scan");
  assert.equal(els.progress.hidden, false, "the progress bar must stay up");

  els.csv.listeners.click();
  assert.equal(blobs.length, 0, "no CSV may be exported mid-scan");
  assert.equal(downloads.length, 0);

  phase = "done";
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(els.report.hidden, false, "the new report renders when its scan finishes");
});

test("app: the exported CSV starts with a BOM, carries the assumed column, and keeps micro digits", async () => {
  const job = doneJob("TOKN");
  const { els, blobs, downloads } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    return jsonRes(job);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 200));
  els.csv.listeners.click();
  assert.equal(blobs.length, 1);
  const text = blobs[0].parts[0];
  assert.equal(text.charCodeAt(0), 0xfeff, "the Blob must start with the UTF-8 BOM");
  assert.ok(text.includes("assumed_gain_usd"), "the assumed column must exist");
  assert.ok(text.includes("0.0000015"), "sub-milli quantities keep their digits");
  assert.equal(downloads.length, 1);
});
