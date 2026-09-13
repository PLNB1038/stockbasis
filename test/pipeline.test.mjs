// End-to-end pipeline tests against a local fake Solana RPC — no network
// dependency for the chain itself, fully deterministic history: what the
// scanner fetches, what the report carries, and what the server serves.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ingestWallet } from "../src/ingest.mjs";
import { buildReport } from "../src/report.mjs";
import { primeTokenCache } from "../src/classify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---- fake chain ------------------------------------------------------------
// A small step-based history: each step is one wallet tx with its TSLAx/USDC
// balance moves; balances run forward so pre/post token balances stay honest.

function buildHistory(steps) {
  let tslax = 0, usdc = 0, slot = 1000;
  const sigs = [], txs = new Map();
  for (const st of steps) {
    slot += 10;
    const sig = `Sig${String(slot).padStart(6, "0")}${"q".repeat(30)}`;
    const preT = tslax, preU = usdc;
    tslax += st.dTslax ?? 0;
    usdc += st.dUsdc ?? 0;
    const meta = { preTokenBalances: [], postTokenBalances: [], preBalances: [1_000_000_000], postBalances: [1_000_000_000 - 5000], fee: 5000 };
    const bal = (mint, amt) => ({ accountIndex: mint === TSLAX ? 1 : 2, mint, owner: OWNER, uiTokenAmount: { uiAmount: amt, uiAmountString: String(amt) } });
    if ((st.dTslax ?? 0) !== 0) { meta.preTokenBalances.push(bal(TSLAX, preT)); meta.postTokenBalances.push(bal(TSLAX, tslax)); }
    if ((st.dUsdc ?? 0) !== 0) { meta.preTokenBalances.push(bal(USDC, preU)); meta.postTokenBalances.push(bal(USDC, usdc)); }
    txs.set(sig, { meta, transaction: { message: { accountKeys: [{ pubkey: OWNER }] } } });
    sigs.push({ signature: sig, slot, blockTime: st.nullTime ? null : st.ts, err: st.err ?? null });
  }
  return { sigs: sigs.reverse(), txs }; // RPC order: newest first
}

const HOUR = 3600;

function fakeRpc(handlers) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const out = handlers[method] ? handlers[method](params) : { result: null };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const now = () => Math.floor(Date.now() / 1000);

test("ingest: history is fetched newest-first and handed over oldest-first", async () => {
  const t = now();
  const { sigs, txs } = buildHistory([
    { ts: t - 5 * HOUR, dTslax: 1.0, dUsdc: -250 },  // buy 1.0
    { ts: t - 4 * HOUR, dTslax: 0.5, dUsdc: -125 },  // buy 0.5
    { ts: t - 3 * HOUR, dUsdc: -20, nullTime: true },// noise with a missing blockTime
    { ts: t - 2 * HOUR, dTslax: -0.8, dUsdc: 210 },  // sell 0.8
    { ts: t - 1 * HOUR, dUsdc: -50 },                // stablecoin-only noise
    { ts: t, err: "oops" },                          // failed tx changed nothing
  ]);
  const fake = await fakeRpc({
    getSignaturesForAddress: () => ({ result: sigs }),
    getTransaction: (p) => ({ result: txs.get(p[0]) ?? null }),
  });
  try {
    const { trades, coverage, seen } = await ingestWallet(OWNER, { rpcUrl: fake.url });
    assert.equal(seen, 5);                                  // the failed tx is skipped
    assert.deepEqual(trades.map((x) => x.side), ["buy", "buy", "sell"]); // oldest first
    assert.deepEqual(trades.map((x) => x.qty), [1.0, 0.5, 0.8]);
    assert.equal(coverage.fromTs, t - 5 * HOUR);             // oldest scanned signature
    assert.equal(coverage.toTs, t - 1 * HOUR);               // newest non-failed signature
  } finally {
    fake.server.close();
  }
});

test("ingest: a -32020 on one mirror is rotated to the next, not a data hole", async () => {
  const t = now();
  const { sigs, txs } = buildHistory([{ ts: t - HOUR, dTslax: 1.0, dUsdc: -250 }]);
  const hole = await fakeRpc({
    getSignaturesForAddress: () => ({ result: sigs }),
    getTransaction: () => ({ error: { code: -32020, message: "Transaction not found" } }),
  });
  const full = await fakeRpc({
    getSignaturesForAddress: () => ({ result: sigs }),
    getTransaction: (p) => ({ result: txs.get(p[0]) ?? null }),
  });
  try {
    const { trades, seen } = await ingestWallet(OWNER, { rpcUrl: `${hole.url},${full.url}` });
    assert.equal(seen, 1);                    // the tx was recovered, not skipped
    assert.equal(trades.length, 1);
    assert.equal(trades[0].side, "buy");
    assert.equal(trades[0].qty, 1.0);
  } finally {
    hole.server.close();
    full.server.close();
  }
});

test("report payload carries every field the web UI binds to", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "Tesla xStock", isStock: true, tags: [] });
  const t = now();
  const trades = [
    { side: "buy", mint: TSLAX, qty: 2, valueUsd: 500, ts: t - 4 * HOUR, slot: 1, signature: "s1" },
    { side: "in", mint: TSLAX, qty: 1, valueUsd: 0, ts: t - 3 * HOUR, slot: 2, signature: "s2" },
    { side: "sell", mint: TSLAX, qty: 1, valueUsd: 260, ts: t - 2 * HOUR, slot: 3, signature: "s3" },
    { side: "sell", mint: TSLAX, qty: 1, valueUsd: 270, ts: t - 1 * HOUR, slot: 4, signature: "s4" },
  ];
  const payload = {
    ...await buildReport(trades),
    reconciled: 0, ambiguous: 0, transfersCount: 1,
    coverage: { fromTs: t - 4 * HOUR, toTs: t - 1 * HOUR, scanned: 4 },
  };

  const row = payload.rows[0];
  for (const f of ["mint", "symbol", "name", "trades", "buys", "sells", "wins", "losses", "unknownBasis",
    "realizedAssumed", "closes", "realizedUsd", "openQty", "openUnknownQty", "openCostUsd", "firstTs", "lastTs"]) {
    assert.ok(f in row, `row.${f} missing`);
  }
  assert.equal(row.trades, 3);        // buys+sells only — deposits are not trades
  assert.equal(row.openUnknownQty, 1); // the custody deposit is still held, basis-less

  assert.equal(payload.closes.length, 2);
  for (const c of payload.closes) {
    for (const f of ["symbol", "mint", "acquiredTs", "soldTs", "qty", "proceedsUsd", "costUsd", "pnlUsd"]) {
      assert.ok(f in c, `close.${f} missing`);
    }
  }
  const soldOrder = payload.closes.map((c) => c.soldTs);
  assert.deepEqual(soldOrder, [...soldOrder].sort((a, b) => b - a)); // newest disposal first

  for (const f of ["rows", "closes", "totalRealized", "totalAssumed", "unknownBasis", "priceCorrections", "tokens",
    "reconciled", "coverage", "ambiguous", "transfersCount"]) {
    assert.ok(f in payload, `payload.${f} missing`);
  }
});

test("server: static guards and the full scan flow over a fake chain", async () => {
  const t = now();
  const { sigs, txs } = buildHistory([
    { ts: t - 3 * HOUR, dTslax: 1.0, dUsdc: -250 }, // buy 1.0
    { ts: t - 2 * HOUR, dTslax: 0.5, dUsdc: -125 }, // buy 0.5
    { ts: t - 1 * HOUR, dTslax: -0.8, dUsdc: 210 }, // sell 0.8 — 0.7 stays "open"
  ]);
  const fake = await fakeRpc({
    getSignaturesForAddress: () => ({ result: sigs }),
    getTransaction: (p) => ({ result: txs.get(p[0]) ?? null }),
    // strict provider rules: the account filter must carry exactly one key —
    // mixed filter+config objects are rejected by stricter RPC providers
    getTokenAccountsByOwner: (p) => {
      const keys = Object.keys(p[1] ?? {});
      if (keys.length !== 1) return { error: { code: -32602, message: "filter must have a single key" } };
      return { result: { value: [] } }; // chain holds nothing
    },
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SOLANA_RPC: fake.url, STOCKBASIS_NO_FEATURED: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  // wait for listen()
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(base + "/")).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, "server did not come up");

  try {
    const home = await (await fetch(base + "/")).text();
    assert.ok(home.includes("app.js?v="), "index must link the versioned bundle");

    // the server only ever serves web/ — sources, package and dotfiles stay 404
    assert.equal(await (await fetch(base + "/src/server.mjs")).status, 404);
    assert.equal(await (await fetch(base + "/package.json")).status, 404);
    assert.equal(await (await fetch(base + "/%2e%2e/package.json")).status, 404);

    // API guards
    const post = (body) => fetch(base + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(await (await post(JSON.stringify({ address: "not-an-address" }))).status, 400);
    assert.equal(await (await post(JSON.stringify({ address: "x".repeat(2000) }))).status, 413);
    assert.equal(await (await fetch(base + "/api/jobs/no-such-job")).status, 404);

    const stats = await (await fetch(base + "/api/stats")).json();
    assert.ok(stats.trackedTokens >= 10, "stats must list the curated universe");

    // full scan flow: submit → poll → reconciled report
    const { id } = await (await post(JSON.stringify({ address: OWNER }))).json();
    let job;
    for (let i = 0; i < 60; i++) {
      job = await (await fetch(`${base}/api/jobs/${id}`)).json();
      if (job.status === "done" || job.status === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(job.status, "done", `scan failed: ${job.error}`);
    const res = job.result;
    assert.ok(Number.isFinite(res.totalRealized));
    assert.ok(res.coverage.fromTs > 0);
    const row = res.rows.find((r) => r.mint === TSLAX);
    assert.ok(row, "TSLAx row missing");
    // the books claim 0.7 open while the chain holds none: reconciliation must
    // true it up to zero instead of showing a phantom position
    assert.ok(Math.abs(row.openQty + (row.openUnknownQty ?? 0)) < 1e-6, `open should be 0, got ${row.openQty}`);
    assert.equal(res.reconciled, 1);
  } finally {
    child.kill("SIGKILL");
    fake.server.close();
  }
});

test("web bundle parses — the duplicated-declaration class of bugs never ships again", () => {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, "web", "app.js")]);
  assert.equal(r.status, 0, `app.js syntax error: ${r.stderr}`);
});

test("classify: a malformed search answer is a cached no-data, not a crash", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "maintenance" })); // not an array
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.JUP_SEARCH_URL = `http://127.0.0.1:${srv.address().port}/search`;
  try {
    const fresh = await import(`../src/classify.mjs?malformed=${Date.now()}`);
    const mint = "UnCuratedMint11111111111111111111111111";
    assert.equal(await fresh.lookupToken(mint), null);
    const t0 = Date.now();
    assert.equal(await fresh.lookupToken(mint), null); // served from cache
    assert.ok(Date.now() - t0 < 50, "cached lookup must not touch the network");
  } finally {
    delete process.env.JUP_SEARCH_URL;
    srv.close();
  }
});
