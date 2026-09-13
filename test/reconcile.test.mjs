// Open-position reconciliation: the reconstructed inventory must agree with
// the chain's live balances; drift is corrected as basis-less movements.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { diffAdjustments, buildReconciledReport } from "../src/reconcile.mjs";
import { buildReport } from "../src/report.mjs";
import { primeTokenCache } from "../src/classify.mjs";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated → no network

test("diffAdjustments: phantom lot detected, unknown qty counts, tolerance respected", () => {
  const rows = [
    { mint: "A", openQty: 5, openUnknownQty: 0 },
    { mint: "B", openQty: 0, openUnknownQty: 2 },
    { mint: "C", openQty: 1, openUnknownQty: 0 },
  ];
  const balances = new Map([["A", 3], ["B", 2], ["C", 1.005]]);
  const adj = diffAdjustments(rows, balances);
  // A: chain 3 vs claimed 5 → −2 phantom; B: exact; C: within the 1% drift tolerance
  assert.deepEqual(adj, [{ mint: "A", diff: -2 }]);
});

test("synthetic reconcile-out consumes the phantom lot without inventing P&L", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }];
  const report = await buildReport(trades);
  const adj = diffAdjustments(report.rows, new Map([[TSLAX, 3]]));
  assert.equal(adj.length, 1);
  assert.equal(adj[0].diff, -2);

  const synth = { side: "out", mint: TSLAX, qty: 2, valueUsd: 0, ts: 1_000_000_000, signature: "chain-reconcile" };
  const rebuilt = await buildReport([...trades, synth]);
  const row = rebuilt.rows.find((r) => r.mint === TSLAX);
  assert.ok(Math.abs(row.openQty - 3) < 1e-9);   // open position now equals the chain
  assert.ok(Math.abs(row.openCostUsd - 300) < 1e-6); // proportional FIFO cost of what remains
  assert.equal(rebuilt.totalRealized, 0);        // no proceeds invented for the unseen disposal
  assert.equal(row.unknownBasis, 0);
});

test("synthetic reconcile-in books an unseen custody deposit as basis-less", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [
    { side: "buy", mint: TSLAX, qty: 1, valueUsd: 100, ts: 100, slot: 1 },
    { side: "sell", mint: TSLAX, qty: 1, valueUsd: 110, ts: 200, slot: 1 },
  ];
  const report = await buildReport(trades);
  const adj = diffAdjustments(report.rows, new Map([[TSLAX, 4]])); // chain holds 4 the scan never saw
  assert.equal(adj[0].diff, 4);

  const synth = { side: "in", mint: TSLAX, qty: 4, valueUsd: 0, ts: 1_000_000_000, signature: "chain-reconcile" };
  const rebuilt = await buildReport([...trades, synth]);
  const row = rebuilt.rows.find((r) => r.mint === TSLAX);
  assert.ok(Math.abs(row.openUnknownQty - 4) < 1e-9); // held, with unknowable basis
  assert.ok(Math.abs(rebuilt.totalRealized - 10) < 1e-6); // the real round trip is untouched
});

test("a failed balance read leaves positions alone instead of zeroing them", async () => {
  // an RPC that errors on every balance request must not poison the report:
  // a transient hiccup must never show up as "you hold nothing, reconciled"
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = `http://127.0.0.1:${srv.address().port}`;
  try {
    primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
    const owner = "Aaaa1111111111111111111111111111111111111111";
    const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }];
    const { report, reconciled, reconcileFailed } = await buildReconciledReport(owner, trades);
    assert.equal(reconciled, 0); // unreadable chain: the scan result stands
    assert.equal(reconcileFailed, 1); // and the report says so instead of hiding it
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty - 5) < 1e-9, `open qty wiped: ${row.openQty}`);
    assert.ok(Math.abs(row.openCostUsd - 500) < 1e-6);
  } finally {
    process.env.SOLANA_RPC = prev;
    srv.close();
  }
});
