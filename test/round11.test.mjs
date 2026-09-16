// Regression tests for the round-11 external review (opus-5). Every test
// pins one proven vector:
//   rpc: overlapping signature pages never double-yield a boundary tx
//   basis: a lot of a few 12-decimals atoms keeps its remainder (relative
//          full-closure test, strict lot drop)
//   rpc: serialization is per endpoint — one slow mirror cannot stall a
//          healthy one, same-mirror calls stay ordered
//   app: the landing strip never claims "pools" the market feed cannot back
//   reconcile: a non-array balance envelope is a failed read, never "empty"
//          that wipes a position (the primary branch, pinned like the confirm
//          branch already was)
//   ingest: an ambiguous trade demoted to a movement carries no stale
//          partial-cash disclosure

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
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) return Promise.resolve({ ok: false, json: async () => ({}) });
  return realFetch(u, o);
};

const { rpc, allSignatures } = await import("../src/rpc.mjs");
const { fifoBasis } = await import("../src/basis.mjs");
const { buildReconciledReport } = await import("../src/reconcile.mjs");
const { applySanityGate } = await import("../src/ingest.mjs");

const servers = [];
const rpcStub = (handler, delayMs = 0) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"));
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
      }, delayMs);
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};

after(() => { for (const s of servers) try { s.close(); } catch { /* already closed */ } });

// ---- V1: overlapping pages never double-yield ------------------------------------------

test("rpc: a mirror serving overlapping pages cannot double a signature", async () => {
  // pages of 2, newest-first, with the boundary signature repeated on the
  // next page (an inclusive-before mirror quirk; the same overlap appears
  // when rotation hands the walk to a mirror with a slightly deeper page)
  const ALL = [["S3", 30], ["S2", 20], ["S1", 10]];
  const stub = await rpcStub((msg) => {
    const before = msg.params[1]?.before;
    let page = before == null ? ALL.slice(0, 2) : ALL.filter(([s]) => s < before).slice(0, 2);
    if (before === "S2") page = ALL.filter(([s]) => s <= before).slice(0, 2); // repeats S2
    return { result: page.map(([signature, t]) => ({ signature, slot: t, blockTime: 1_700_000_000 + t, err: null })) };
  });
  const out = [];
  for await (const s of allSignatures(OWNER, { rpcUrl: stub.url })) out.push(s.signature);
  assert.deepEqual(out, ["S3", "S2", "S1"], `each signature exactly once (got ${out.join(",")})`);
});

// ---- V2: nano lots keep their remainder -------------------------------------------------

test("basis: a lot of a few 12-decimals atoms keeps its remainder", () => {
  const r = fifoBasis([
    { side: "buy", mint: TSLAX, qty: 2e-12, valueUsd: 100, ts: 1, slot: 1 },
    { side: "sell", mint: TSLAX, qty: 1e-12, valueUsd: 60, ts: 2, slot: 2 },
  ]);
  assert.equal(r.closes.length, 1);
  assert.ok(Math.abs(r.closes[0].costUsd - 50) < 1e-9, `half the lot costs half the basis (got ${r.closes[0].costUsd})`);
  assert.ok(Math.abs(r.realizedUsd - 10) < 1e-9, `half sold for 60 against 50 = +10 (got ${r.realizedUsd})`);
  assert.ok(Math.abs(r.openQty - 1e-12) < 1e-18, `one atom stays open (got ${r.openQty})`);
  assert.ok(Math.abs(r.openCostUsd - 50) < 1e-9, `with its half of the basis (got ${r.openCostUsd})`);
});

// ---- V3: per-endpoint serialization ------------------------------------------------------

test("rpc: a slow mirror cannot stall a healthy one", async () => {
  const slow = await rpcStub(() => ({ result: { version: "slow" } }), 600);
  const fast = await rpcStub(() => ({ result: { version: "fast" } }), 200);
  // one slow call to mirror A runs alongside three paced calls to mirror B:
  // per-endpoint chains finish in ~max(600, 3×200) = 600ms; a single global
  // chain would serialize everything into 600 + 3×200 = 1200ms
  const t0 = Date.now();
  const [a, ...rest] = await Promise.all([
    rpc("getVersion", [], { rpcUrl: slow.url }),
    rpc("getVersion", [], { rpcUrl: fast.url }),
    rpc("getVersion", [], { rpcUrl: fast.url }),
    rpc("getVersion", [], { rpcUrl: fast.url }),
  ]);
  const ms = Date.now() - t0;
  assert.equal(a.version, "slow");
  assert.ok(rest.every((r) => r.version === "fast"));
  assert.ok(ms < 900, `different mirrors run in parallel (took ${ms}ms — a global chain would need ~1200)`);

  // same mirror: the chain still serializes — two slow calls cannot overlap
  const t1 = Date.now();
  await Promise.all([
    rpc("getVersion", [], { rpcUrl: slow.url }),
    rpc("getVersion", [], { rpcUrl: slow.url }),
  ]);
  const serial = Date.now() - t1;
  assert.ok(serial >= 1000, `same-mirror calls stay ordered (took ${serial}ms, need ≥2×600)`);
});

// ---- V4: the strip never claims unbacked pools ------------------------------------------

test("app: the market strip prints pools only the feed can back", async () => {
  const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const run = (statsBody) => {
    const els = {};
    const el = (id) => els[id] ??= { hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {}, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); } };
    for (const id of ["featured", "featured-list", "market", "scan", "address", "go", "progress", "progress-text", "bar-fill", "error", "report", "total", "total-sub", "assume", "assume-opt", "basis-note", "drows", "dnote", "dtable", "rows", "csv"]) el(id);
    vm.runInNewContext(appCode, {
      document: { getElementById: el, querySelectorAll: () => [], createElement: () => ({ href: "", download: "", click() {} }) },
      fetch: async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes("/api/stats") ? statsBody : []) }),
      URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, Blob: class {},
      console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite, setTimeout, clearTimeout, AbortSignal, Intl,
    });
    return els;
  };
  const down = run({ volume24hUsd: 0, trackedTokens: 18, tokensWithPools: 0, top: [] });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!/pools/.test(down.market.textContent), `feed down must not claim pools (got "${down.market.textContent}")`);
  assert.ok(/18 tokenized equities tracked/.test(down.market.textContent), "the static universe count still shows, honestly");

  const live = run({ volume24hUsd: 41_000_000, trackedTokens: 18, tokensWithPools: 5, top: [{ symbol: "DKNG" }] });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(/5 tokenized-equity pools tracked/.test(live.market.textContent), `live pools show (got "${live.market.textContent}")`);
});

// ---- V5: a non-array balance envelope is a failed read -----------------------------------

test("reconcile: a proxy envelope instead of an account list never wipes a position", async () => {
  // every balance read answers a 200-OK object where an account list belongs:
  // without the shape guard, {}.length reads as "empty", the single-mirror
  // fallback trusts it, and a $1000 position is zeroed as "reconciled"
  const stub = await rpcStub((msg) => {
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: {} } };
    return { result: { value: [] } };
  });
  const trades = [{ side: "buy", mint: TSLAX, qty: 10, valueUsd: 1000, ts: 1_700_000_000, slot: 1 }];
  const { report, reconciled, reconcileFailed } = await buildReconciledReport(OWNER, trades, { rpcUrl: stub.url });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.ok(Math.abs(row.openQty - 10) < 1e-9, `the position survives (openQty=${row.openQty})`);
  assert.equal(reconciled, 0, "nothing was reconciled");
  assert.equal(reconcileFailed, 1, "the unreadable balance is disclosed as a failed read");
});

// ---- bonus: an ambiguous demotion sheds its partial-cash disclosure ----------------------

test("ingest: a trade demoted to a movement carries no partial-cash note", () => {
  const old = Date.now() / 1000 - 30 * 86400;
  const trades = [{ side: "sell", mint: TSLAX, qty: 1, valueUsd: 50, ts: old, slot: 1, signature: "s", partialCash: true }];
  const { ambiguous } = applySanityGate(trades, new Map([[TSLAX, { px: 500, liq: 1 }]]), Date.now() / 1000);
  assert.equal(ambiguous, 1);
  assert.equal(trades[0].side, "out");
  assert.equal(trades[0].valueUsd, 0);
  assert.notEqual(trades[0].partialCash, true, "a movement has no proceeds to understate — the disclosure must not outlive the trade");
});
