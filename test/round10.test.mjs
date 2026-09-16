// Regression tests for polish round 10 (external review + core critic).
//   ingest: a wrapped SOL flow is not payment for stock (phantom purchase)
//   ingest: an unclassifiable swap leg cannot inflate a purchase's basis
//   ingest: a WSOL leg with a live price is proceeds (mutation survived)
//   ingest: rent is clipped in the legless SOL path too (mutation survived)
//   ingest: a trade priced on its stable leg only carries partialCash
//   report/ui: partialCash is counted and disclosed, never silent
//   basis: statement proceeds reconcile to the chain's cash (largest remainder)
//   basis: float noise never leaves a negative-cost lot

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111";
const OTHER = "Bbbb1111111111111111111111111111111111111111";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const WSOL = "So11111111111111111111111111111111111111112";
const MEME = "MemeMint11111111111111111111111111111111111"; // not curated, not a stable

// offline determinism: SOL history must never reach the price API
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) return Promise.resolve({ ok: false, json: async () => ({}) });
  return realFetch(u, o);
};

// Jupiter stub: the unclassified mint answers an empty (no-data) list — same
// shape a real lookup miss produces — so pairTrades sees a null classification
const servers = [];
const jup = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
process.env.JUP_SEARCH_URL = `http://127.0.0.1:${jup.address().port}/search`;

const { pairTrades } = await import("../src/ingest.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");
const { primeSolDayCache } = await import("../src/price.mjs");
const { fifoBasis } = await import("../src/basis.mjs");
const { buildReport } = await import("../src/report.mjs");

primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(PYUSD, { symbol: "PYUSD", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });
primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });

after(() => { for (const s of servers) try { s.close(); } catch { /* already closed */ } });

const run = async (deltas, ctx) => {
  const trades = [];
  const transfers = [];
  await pairTrades(deltas, { slot: 1, signature: "r10", closedAta: 0, ...ctx }, trades, transfers);
  return { trades, transfers };
};

// ---- C1: the native tail must be SOL the wallet actually paid for stock ----

test("ingest: a wrapped SOL flow is not payment for stock", async () => {
  // deposit into custody that wraps SOL in passing: TSLAx +5, WSOL +2, native
  // SOL −2 — the wallet's SOL merely changed shape, nothing was paid for stock
  const ts = 1736200000;
  primeSolDayCache(ts, 200); // a live quote, so the only thing stopping the
  // phantom purchase on old code would have been the missing netting
  const { trades } = await run(
    [
      { mint: TSLAX, delta: 5 },
      { mint: WSOL, delta: 2 },
    ],
    { ts, solDelta: -2e9 },
  );
  assert.equal(trades.length, 1, "the movement still books");
  assert.equal(trades[0].side, "in", "a wrap netted to zero is a deposit, not a phantom purchase with invented basis");
  assert.equal(trades[0].valueUsd, 0);
  // control: the same native outflow WITHOUT the wrap side is a real purchase
  primeSolDayCache(ts + 3600, 200);
  const real = await run([{ mint: TSLAX, delta: 5 }], { ts: ts + 3600, solDelta: -2e9 });
  assert.equal(real.trades[0].side, "buy", "the legless SOL path still prices real payments");
  assert.equal(real.trades[0].valueUsd, 400);
});

test("ingest: an unclassifiable swap leg cannot inflate a purchase's basis", async () => {
  // a meme coin bought for 2 SOL inside the same tx as a clean USDC purchase:
  // the native flow belongs to the other leg, not to the stock
  primeSolDayCache(1736300000, 200);
  const { trades } = await run(
    [
      { mint: TSLAX, delta: 5 },
      { mint: USDC, delta: -500 },
      { mint: MEME, delta: 2 },
    ],
    { ts: 1736300000, solDelta: -2e9 },
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "buy");
  assert.equal(trades[0].valueUsd, 500, `the basis is the USDC actually paid (got ${trades[0].valueUsd})`);
});

// ---- C2/C3: the two SOL paths that survived mutations ----------------------------------

test("ingest: a WSOL leg with a live price is proceeds", async () => {
  primeSolDayCache(1736400000, 200);
  const { trades } = await run(
    [
      { mint: TSLAX, delta: -2 },
      { mint: WSOL, delta: 0.5 },
    ],
    { ts: 1736400000, solDelta: 0 },
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "sell", "a sale paid in WSOL with a live quote is a sale");
  assert.equal(trades[0].valueUsd, 100, `0.5 WSOL at $200 (got ${trades[0].valueUsd})`);
});

test("ingest: rent is clipped in the legless SOL path too", async () => {
  const ts = 1736500000;
  primeSolDayCache(ts, 200);
  // 0.0674 SOL out with 30 closed accounts: 63e6 lamports of it is refund dust
  const rent = await run([{ mint: TSLAX, delta: 5 }], { ts, solDelta: -0.0674e9, closedAta: 30 });
  assert.equal(rent.trades[0].side, "in", "a net-of-rent tail below the floor is a deposit, not a micro-purchase");
  // control: the same outflow without refunds is a real (small) purchase
  const real = await run([{ mint: TSLAX, delta: 5 }], { ts, solDelta: -0.0674e9, closedAta: 0 });
  assert.equal(real.trades[0].side, "buy");
  assert.ok(Math.abs(real.trades[0].valueUsd - 13.48) < 0.01, `net-of-nothing prices fully (got ${real.trades[0].valueUsd})`);
});

// ---- X1: partial pricing must be disclosed, never silent --------------------------------

test("ingest: a trade priced on its stable leg only carries partialCash", async () => {
  const ts = 1736600000; // no seeded price; the offline stub answers !ok
  const { trades, transfers } = await run(
    [
      { mint: TSLAX, delta: -1 },
      { mint: USDC, delta: 200 },
      { mint: WSOL, delta: 1 },
    ],
    { ts, solDelta: 0 },
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].valueUsd, 200, "the stable half prices the trade");
  assert.equal(trades[0].partialCash, true, "the understated valuation must be flagged, not silent");
  assert.ok(transfers.some((t) => t.mint === WSOL && Math.abs(t.delta - 1) < 1e-9), "the unpriced WSOL lands in the ledger");
  // control: a fully priced stable sale carries no flag
  const clean = await run(
    [
      { mint: TSLAX, delta: -1 },
      { mint: USDC, delta: 200 },
    ],
    { ts, solDelta: 0 },
  );
  assert.notEqual(clean.trades[0].partialCash, true, "a fully valued trade is not marked");
});

test("report/ui: partialCash is counted and disclosed", async () => {
  const mk = (partial) => ({ side: "sell", mint: TSLAX, qty: 1, valueUsd: 200, ts: 1736700000, slot: 1, signature: "p" + partial, ...(partial ? { partialCash: true } : {}) });
  const report = await buildReport([mk(true), mk(true), mk(false)]);
  assert.equal(report.partialCash, 2, `the counter counts partial trades (got ${report.partialCash})`);

  const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const els = {};
  const el = (id) => els[id] ??= {
    hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {},
    listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); },
  };
  for (const id of ["featured", "featured-list", "market", "scan", "address", "go", "progress", "progress-text", "bar-fill", "error", "report", "total", "total-sub", "assume", "assume-opt", "basis-note", "drows", "dnote", "dtable", "rows", "csv"]) el(id);
  vm.runInNewContext(appCode, {
    document: { getElementById: el, querySelectorAll: () => [], createElement: () => ({ href: "", download: "", click() {} }) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "j1", address: OWNER, status: "done", progress: 1, trades: 1, phase: "done", error: null, result: { ...report, rows: [{ mint: TSLAX, symbol: "TSLAx", name: "", trades: 1, buys: 0, sells: 1, wins: 0, losses: 1, unknownBasis: 0, realizedUsd: -1, realizedAssumed: 0, openQty: 0, openUnknownQty: 0, openCostUsd: 0, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }], disposals: [], coverage: null, tokens: 1, unknownBasis: 0, totalRealized: -1, totalAssumed: 0 } }) }),
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {},
    console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite, setTimeout, clearTimeout, AbortSignal, Intl,
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(/stablecoin leg only/.test(els["basis-note"].textContent), `the disclosure renders (got "${els["basis-note"].textContent}")`);
});

// ---- D-V3: same-sign cash hops must not fall out of the ledger ------------------------

test("ingest: a same-sign cash hop lands in the ledger even on a cleanly priced trade", async () => {
  // sale of 5 for 500 USDC with a −3 USDT routing hop in the same tx: the
  // USDT leg never pairs with the equity (same sign), but it is real money
  const { trades, transfers } = await run(
    [
      { mint: TSLAX, delta: -5 },
      { mint: USDC, delta: 500 },
      { mint: PYUSD, delta: -3 },
    ],
    { ts: 1736800000, solDelta: 0 },
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].valueUsd, 500, "the paired leg still prices the trade");
  assert.ok(transfers.some((t) => t.mint === PYUSD && t.delta === -3), "the routing hop is recorded as a movement");
});

// ---- D-V2: a done answer arriving after a newer submit must not render -----------------

test("app: a done answer that lands after a newer submit never renders", async () => {
  const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const mkEls = () => {
    const els = {};
    const el = (id) => els[id] ??= {
      hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {},
      listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); },
    };
    for (const id of ["featured", "featured-list", "market", "scan", "address", "go", "progress", "progress-text", "bar-fill", "error", "report", "total", "total-sub", "assume", "assume-opt", "basis-note", "drows", "dnote", "dtable", "rows", "csv"]) el(id);
    return { els, el };
  };
  const { els, el } = mkEls();
  let releaseA;
  const doneA = {
    id: "jA", address: "A", status: "done", progress: 1, trades: 1, phase: "done", error: null,
    result: { rows: [{ mint: TSLAX, symbol: "TSLAx", name: "", trades: 1, buys: 1, sells: 0, wins: 1, losses: 0, unknownBasis: 0, realizedUsd: 777, realizedAssumed: 0, openQty: 1, openUnknownQty: 0, openCostUsd: 10, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }], totalRealized: 777, totalAssumed: 0, tokens: 1, unknownBasis: 0, coverage: null, disposals: [] },
  };
  let posts = 0;
  let jbGets = 0;
  vm.runInNewContext(appCode, {
    document: { getElementById: el, querySelectorAll: () => [], createElement: () => ({ href: "", download: "", click() {} }) },
    fetch: (url, opts) => {
      if (!String(url).includes("/api/jobs")) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      if (opts?.method === "POST") { posts++; return Promise.resolve({ ok: true, status: 202, json: async () => ({ id: posts === 1 ? "jA" : "jB" }) }); }
      const id = String(url).includes("/jA") ? "jA" : "jB";
      if (id === "jA") return new Promise((resolve) => { releaseA = () => resolve({ ok: true, status: 200, json: async () => doneA }); });
      jbGets++;
      // scan B finishes after two progress ticks so the sandbox's poll loop
      // (and its timers) end and the test file can exit
      const body = jbGets <= 2
        ? { id: "jB", address: "B", status: "running", progress: 2, trades: 0, phase: "scan", error: null }
        : { id: "jB", address: "B", status: "done", progress: 2, trades: 0, phase: "done", error: null, result: { rows: [], totalRealized: 0, totalAssumed: 0, tokens: 0, unknownBasis: 0, coverage: null, disposals: [] } };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {},
    console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite, setTimeout, clearTimeout, AbortSignal, Intl,
  });
  els.address.value = OWNER;
  els.scan.requestSubmit(); // scan A starts; its GET hangs on releaseA
  await new Promise((r) => setTimeout(r, 100));
  els.address.value = OTHER;
  els.scan.requestSubmit(); // scan B supersedes A
  await new Promise((r) => setTimeout(r, 150));
  releaseA(); // A's done answer finally arrives — after the newer submit
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(els.report.hidden, true, "a stale report must not surface over the running scan");
  assert.ok(!/777/.test(els.total.textContent), `wallet A's total must never show (got "${els.total.textContent}")`);
  assert.ok(/Scanned/.test(els["progress-text"].textContent), `scan B's progress stays live (got "${els["progress-text"].textContent}")`);
});


// ---- X2/C4: statement rows reconcile to the chain's cash; lots stay non-negative ---------

const cents = (v) => Math.round(v * 100) / 100;

test("basis: statement proceeds reconcile to the chain's cash", () => {
  // the grid-trader repro: 500 equal lots closed by one sale
  const trades = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < 500; i++) trades.push({ side: "buy", mint: TSLAX, qty: 0.02, valueUsd: 4, ts: ts + i, slot: i, signature: "b" + i });
  trades.push({ side: "sell", mint: TSLAX, qty: 10, valueUsd: 4127.77, ts: ts + 1000, slot: 1000, signature: "s" });
  const { closes, realizedUsd } = fifoBasis(trades);
  const sumRows = cents(closes.reduce((s, c) => s + c.proceedsUsd, 0));
  assert.equal(sumRows, 4127.77, `rows must sum to the cash received (got ${sumRows})`);
  assert.equal(cents(closes.reduce((s, c) => s + c.pnlUsd, 0)), cents(realizedUsd), "the total is still the sum of its atoms");

  // mixed known/unknown inventory across several sells: every dollar of sale
  // cash lands in exactly one row (known or unknown-basis)
  const mixed = [
    { side: "buy", mint: TSLAX, qty: 3, valueUsd: 300, ts: 1, slot: 1, signature: "m1" },
    { side: "in", mint: TSLAX, qty: 2, valueUsd: 0, ts: 2, slot: 2, signature: "m2" },
    { side: "sell", mint: TSLAX, qty: 4, valueUsd: 500.005, ts: 3, slot: 3, signature: "m3" },
    { side: "sell", mint: TSLAX, qty: 1, valueUsd: 125.25, ts: 4, slot: 4, signature: "m4" },
  ];
  const res = fifoBasis(mixed);
  const allRows = cents([...res.closes.map((c) => c.proceedsUsd), ...res.unknownBasis.map((u) => u.proceedsUsd)].reduce((s, v) => s + v, 0));
  assert.equal(allRows, cents(500.005 + 125.25), `known and unknown rows share the sale budget exactly (got ${allRows})`);

  // random streams: no cent leaks between rows, cash and totals
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let iter = 0; iter < 100; iter++) {
    const stream = [];
    let clock = 1_700_000_000;
    for (let i = 0; i < 12; i++) {
      clock += Math.floor(rnd() * 100) + 1;
      const side = rnd() < 0.45 ? "buy" : rnd() < 0.75 ? "sell" : rnd() < 0.5 ? "in" : "out";
      stream.push({ side, mint: TSLAX, qty: cents(rnd() * 5 + 0.01), valueUsd: cents(rnd() * 900 + 10), ts: clock, slot: i, signature: "f" + iter + "_" + i });
    }
    const r = fifoBasis(stream);
    const sold = stream.filter((t) => t.side === "sell").reduce((s, t) => s + t.valueUsd, 0);
    const rows = cents([...r.closes.map((c) => c.proceedsUsd), ...r.unknownBasis.map((u) => u.proceedsUsd)].reduce((s, v) => s + v, 0));
    const covered = cents(r.closes.reduce((s, c) => s + c.qty, 0) + r.unknownBasis.reduce((s, u) => s + u.qty, 0));
    const boughtPlusIn = cents(stream.filter((t) => t.side === "buy" || t.side === "in").reduce((s, t) => s + t.qty, 0));
    if (Math.abs(covered - Math.min(boughtPlusIn, stream.filter((t) => t.side === "sell").reduce((s, t) => s + t.qty, 0))) < 1e-9) {
      assert.ok(Math.abs(rows - cents(sold)) < 0.005, `fully covered sale cash must reconcile (iter ${iter}: rows ${rows} vs sold ${cents(sold)})`);
    }
    assert.ok(r.openCostUsd >= -1e-9, `no negative open cost (iter ${iter}: ${r.openCostUsd})`);
    for (const c of r.closes) assert.ok(c.costUsd >= 0 && c.proceedsUsd >= 0, `atoms stay non-negative (iter ${iter})`);
  }
});
