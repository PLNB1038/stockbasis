// Hardening regression tests from the pre-deadline QA pass.
// Each test pins a failure mode that a demo run must survive: one bad mirror
// answer, one classification outage, one throttled price API.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// must be set before classify.mjs loads (it reads the env once, at import)
process.env.JUP_SEARCH_URL = "http://127.0.0.1:9/unreachable";
const { buildReport } = await import("../src/report.mjs");
const { buildReconciledReport } = await import("../src/reconcile.mjs");
const { solUsdOn } = await import("../src/price.mjs");

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated → no network
const OWNER = "Aaaa1111111111111111111111111111111111111111";

test("a classification outage must not crash or discard a finished scan", async () => {
  // JUP_SEARCH_URL points at a closed port: every lookup for a non-curated
  // mint throws. The scan is done at this point — losing it to a metadata
  // hiccup is the bug this pins.
  const MINT = "QaUnCuratedMintForOutageTest1111111111111111111";
  const trades = [
    { side: "buy", mint: MINT, qty: 10, valueUsd: 100, ts: 1700000000, slot: 1, signature: "x1" },
    { side: "sell", mint: MINT, qty: 10, valueUsd: 120, ts: 1700000100, slot: 2, signature: "x2" },
  ];
  const r = await buildReport(trades);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].symbol, MINT.slice(0, 6)); // honest "unknown", not a crash
  assert.ok(Math.abs(r.totalRealized - 20) < 1e-9); // the P&L survives
});

test("an empty balance answer from ONE mirror must not wipe real positions", async () => {
  // two ports, one shared handler: the first balance ask for a mint answers
  // empty (a shallow mirror), any retry sees the real 5-token ATA. Whichever
  // port the rotator picks first, the outcome must be the same.
  const asks = new Map();
  const handler = (req, res) => {
    const n = (asks.get("n") ?? 0) + 1;
    asks.set("n", n);
    const value = n === 1 ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 5 } } } } } }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }));
  };
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = `http://127.0.0.1:${a.address().port},http://127.0.0.1:${b.address().port}`;
  try {
    const { report, reconciled } = await buildReconciledReport(OWNER, [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }]);
    assert.equal(asks.get("n"), 2); // exactly one cross-check, not a storm
    assert.equal(reconciled, 0); // nothing to fix: the wallet truly holds 5
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty - 5) < 1e-9, `open qty wiped: ${row.openQty}`);
    assert.ok(Math.abs(row.openCostUsd - 500) < 1e-6, `basis wiped: ${row.openCostUsd}`);
  } finally {
    process.env.SOLANA_RPC = prev;
    a.close(); b.close();
  }
});

test("a position the whole mirror list agrees is gone is still cleaned up", async () => {
  // back-compat for the legitimate use of reconcile: phantom lots from a
  // history hole must keep disappearing when every mirror agrees on empty
  const mk = () => http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }));
  });
  const a = mk(); const b = mk();
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = `http://127.0.0.1:${a.address().port},http://127.0.0.1:${b.address().port}`;
  try {
    const { report, reconciled } = await buildReconciledReport(OWNER, [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }]);
    assert.equal(reconciled, 1);
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty) < 1e-9); // phantom lot removed
  } finally {
    process.env.SOLANA_RPC = prev;
    a.close(); b.close();
  }
});

test("a throttled price day is re-asked at most once per TTL window", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
  try {
    // a recent day inside CoinGecko's 365-day window (an ancient day is answered
    // locally without any fetch — pinned by round70-ingest); no test seeds this day
    const ts = Math.floor(Date.now() / 1000) - 10 * 86400;
    const first = await solUsdOn(ts);
    const second = await solUsdOn(ts);
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(calls, 1); // the second lookup was served from the miss cache
  } finally {
    globalThis.fetch = realFetch;
  }
});
