// Robustness regressions from the adversarial ("hater") QA pass:
//   1. disposals inside multi-token bundles must be disclosed, not dropped
//   2. a transient "no data" classification answer must not blind the process forever
//   3. a scan must die when its job times out — no zombies burning the RPC queue
//   4. an empty balance answer is verified against a mirror that did NOT serve it

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// a fake Jupiter: the first ask FOR THE PROBE MINT answers empty (index lag),
// every later ask for it serves the token; other mints are always unknown.
// Per-mint state matters — earlier tests in this file also look mints up.
const PROBE = "TtlProbe1111111111111111111111111111111111111";
let probeServed = 0;
const jup = http.createServer((req, res) => {
  const q = new URL(req.url, "http://localhost").searchParams.get("query") ?? "";
  res.writeHead(200, { "Content-Type": "application/json" });
  if (q !== PROBE || ++probeServed > 1) {
    res.end(JSON.stringify(q === PROBE ? [{ id: PROBE, symbol: "TTLx", name: "Ttl Probe", tags: ["stocks"] }] : []));
  } else {
    res.end("[]");
  }
});
await new Promise((r) => jup.listen(0, "127.0.0.1", r));
process.env.JUP_SEARCH_URL = `http://127.0.0.1:${jup.address().port}/search`;
// long enough to outlive the post-cache politeness sleep inside lookupToken,
// short enough that the expiry retry is testable in seconds
process.env.CLASSIFY_NULL_TTL_MS = "2000";

const { lookupToken, primeTokenCache } = await import("../src/classify.mjs");
const { pairTrades, ingestWallet, tokenDeltas, applySanityGate } = await import("../src/ingest.mjs");
const { fifoBasis } = await import("../src/basis.mjs");
const { buildReport } = await import("../src/report.mjs");
const { buildReconciledReport } = await import("../src/reconcile.mjs");
const { rpc } = await import("../src/rpc.mjs");

// idle keep-alive sockets would keep this test file's process alive
after(() => { jup.closeAllConnections?.(); jup.close(); });

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated → no network
const OWNER = "Aaaa1111111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("multi-stock bundle: lots are consumed, and the unpriced disposals are counted", async () => {
  const A = "StockA11111111111111111111111111111111111111111";
  const B = "StockB11111111111111111111111111111111111111111";
  primeTokenCache(A, { symbol: "A", name: "", isStock: true, tags: [] });
  primeTokenCache(B, { symbol: "B", name: "", isStock: true, tags: [] });

  const trades = [];
  await pairTrades(
    [{ mint: A, delta: -10 }, { mint: B, delta: -10 }, { mint: USDC, delta: 950 }],
    { ts: 1757800000, slot: 1, signature: "agg-sell" },
    trades, [], { classifyFailed: 0 },
  );
  assert.ok(trades.every((t) => t.aggregated === true));
  assert.ok(trades.every((t) => t.side === "out")); // never a guessed sell

  const history = [
    { side: "buy", mint: A, qty: 10, valueUsd: 500, ts: 1757700000, slot: 1, signature: "b1" },
    { side: "buy", mint: B, qty: 10, valueUsd: 300, ts: 1757700100, slot: 1, signature: "b2" },
    ...trades,
  ];
  const r = await buildReport(history);
  assert.equal(r.aggregatedDisposals, 2); // both real disposals are disclosed
  assert.equal(r.totalRealized, 0);       // and no proceeds are invented
  assert.equal(r.closes.length, 0);
});

test("a transient no-data answer is retried after the TTL, not cached forever", async () => {
  const first = await lookupToken(PROBE);
  assert.equal(first, null);          // index lag: empty answer
  assert.equal(await lookupToken(PROBE), null); // within the TTL: no re-ask
  assert.equal(probeServed, 1);
  await new Promise((r) => setTimeout(r, 2100)); // TTL expires
  const third = await lookupToken(PROBE);       // Jupiter now serves the token
  assert.equal(third?.isStock, true);
  assert.equal(third?.symbol, "TTLx");
  assert.equal(probeServed, 2);
});

test("aborting a scan rejects it promptly instead of leaving a zombie", async () => {
  // a mirror that accepts the connection and never answers: without abort
  // support this scan would sit in fetch timeouts for minutes after its job
  // was already reported as timed out
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const ac = new AbortController();
  const t0 = Date.now();
  const scan = ingestWallet(OWNER, { rpcUrl: `http://127.0.0.1:${srv.address().port}`, signal: ac.signal, maxScanTx: 10 });
  setTimeout(() => ac.abort(new Error("scan timed out")), 300);
  await assert.rejects(scan);
  assert.ok(Date.now() - t0 < 5000, "abort did not propagate promptly");
  srv.closeAllConnections(); // the hung request socket must not outlive the test
  srv.close();
});

test("the empty-answer cross-check skips exactly the mirror that answered", async () => {
  // mirror A always answers empty; mirror B sees the real 5-token position.
  // The verification call must land on B (A already had its say).
  const hits = { a: 0, b: 0 };
  const mk = (which, value) => (req, res) => {
    hits[which]++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }));
  };
  const a = http.createServer(mk("a", []));
  const b = http.createServer(mk("b", [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 5 } } } } } }]));
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  const prev = process.env.SOLANA_RPC;
  try {
    const rpcUrl = `http://127.0.0.1:${a.address().port},http://127.0.0.1:${b.address().port}`;
    const { report, reconciled } = await buildReconciledReport(OWNER, [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }], { rpcUrl });
    assert.equal(reconciled, 0);
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty - 5) < 1e-9, `open qty wiped: ${row.openQty}`);
    assert.ok(hits.b >= 1, "the cross-check never asked the second mirror");
  } finally {
    process.env.SOLANA_RPC = prev;
    a.closeAllConnections(); b.closeAllConnections();
    a.close(); b.close();
  }
});

test("a weekly market move is not an aggregator error: the real cash leg stands", () => {
  // buy 3 days ago at $15; the token trades at $10 today (−33% in a week —
  // normal for a pre-IPO ticker). Repricing this trade at today's spot would
  // silently rewrite $150 the wallet actually paid into $100.
  const MINT = "MovStock11111111111111111111111111111111111111";
  const now = 1_758_000_000;
  const trades = [{ side: "buy", mint: MINT, qty: 10, valueUsd: 150, ts: now - 3 * 86400, signature: "m1" }];
  const { corrected, ambiguous } = applySanityGate(trades, new Map([[MINT, 10]]), now);
  assert.equal(corrected, 0);
  assert.equal(ambiguous, 0);
  assert.equal(trades[0].valueUsd, 150); // what the wallet actually paid survives
  assert.equal(trades[0].priceCorrected, undefined);

  // the same gate still catches real aggregator garbage (10x off)
  const garbage = [{ side: "sell", mint: MINT, qty: 5, valueUsd: 5, ts: now - 3 * 86400, signature: "m2" }];
  const out = applySanityGate(garbage, new Map([[MINT, 10]]), now);
  assert.equal(out.corrected, 1);
  assert.equal(garbage[0].valueUsd, 50);
});

test("the market-basis assumption prices only recent disposals", () => {
  const mk = (ts, marketPxAt) => ([
    { side: "in", mint: "X", qty: 5, ts: 1_000, signature: "i" },
    { side: "sell", mint: "X", qty: 5, valueUsd: 500, ts, marketPx: 10, marketPxAt, signature: "s" },
  ]);
  // quote fetched a day after the sale: a fair stand-in — assumption applies
  const fresh = fifoBasis(mk(1_000_000, 1_000_000 + 86400));
  assert.ok(Math.abs(fresh.realizedAssumed - 450) < 1e-9);
  // quote fetched a month after the sale: today's price must not value it
  const stale = fifoBasis(mk(1_000_000, 1_000_000 + 30 * 86400));
  assert.equal(stale.realizedAssumed, 0);
  assert.equal(stale.realizedUsd, 0); // strict stays strict either way
});

test("a single unit of a 9-decimals token is a movement, not dust", async () => {
  // SPL mints allow 9 decimals: one unit = 1e-9 — the old 1e-9 dust filter
  // deleted exactly this movement, breaking the "deltas fully explained" law
  const MINT = "NanoStock1111111111111111111111111111111111111";
  primeTokenCache(MINT, { symbol: "N", name: "", isStock: true, tags: [] });

  const meta = {
    preTokenBalances: [],
    postTokenBalances: [{ mint: MINT, owner: OWNER, accountIndex: 0, uiTokenAmount: { uiAmountString: "0.000000001" } }],
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 1);
  assert.ok(Math.abs(deltas[0].delta - 1e-9) < 1e-15);

  const trades = [];
  await pairTrades(deltas, { ts: 1758000000, slot: 1, signature: "u1" }, trades, [], { classifyFailed: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "in");
  assert.ok(Math.abs(trades[0].qty - 1e-9) < 1e-15);
});

test("pacing is per endpoint: different mirrors do not wait for each other", async () => {
  // old behavior: one global 120ms pacer for ALL endpoint lists — a background
  // precompute scan on public mirrors starved interactive calls to a different
  // mirror. Two simultaneous calls to two mirrors must arrive together.
  const mk = () => {
    const s = { arrived: [] };
    s.srv = http.createServer((req, res) => {
      s.arrived.push(Date.now());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 0 }));
    });
    return s;
  };
  const a = mk(), b = mk();
  await new Promise((r) => a.srv.listen(0, "127.0.0.1", r));
  await new Promise((r) => b.srv.listen(0, "127.0.0.1", r));
  const urlA = `http://127.0.0.1:${a.srv.address().port}`;
  const urlB = `http://127.0.0.1:${b.srv.address().port}`;
  try {
    await Promise.all([rpc("getVersion", [], { rpcUrl: urlA }), rpc("getVersion", [], { rpcUrl: urlB })]);
    const gap = Math.abs(a.arrived[0] - b.arrived[0]);
    assert.ok(gap < 100, `cross-mirror calls were paced against each other: ${gap}ms`);

    // same mirror: the spacing guarantee itself must survive
    await rpc("getVersion", [], { rpcUrl: urlA });
    await rpc("getVersion", [], { rpcUrl: urlA });
    assert.ok(a.arrived[2] - a.arrived[1] >= 100, "per-mirror spacing was lost");
  } finally {
    a.srv.closeAllConnections(); b.srv.closeAllConnections();
    a.srv.close(); b.srv.close();
  }
});
