// Regression tests for polish round 8. Every test pins one proven vector:
//   rpc: a short page (< limit) must not end the signature walk
//   rpc: a mirror repeating one page must not loop the walk forever
//   rpc: result:null rotates mirrors before answering null
//   rpc: null from every mirror returns null honestly
//   ingest: the smallest unit of a 12-decimals mint survives the dust filter
//   ingest: SOL proceeds price on top of a stable tail, never drop
//   ingest: a dust sweep of a second stock must not demote the real trade
//   ingest: PYUSD is a cash leg
//   ingest: an authority flip books the full account movement both ways
//   ingest: cash legs of aggregated and unpriced txs land in the ledger
//   ingest: the stop target counts buys/sells only, never transfers
//   basis: reconcile synthetics stay out of the activity window
//   server: env numbers pass the finite-or-default gate (empty != zero)
//   server: featured precompute reconciliation rides PRECOMPUTE_RPC
//   server: /api/featured serves only validated entries
//   app: a JSON body without a job shape is a blip, not "Scanned undefined"
//   app: a hanging poll request is aborted and retried
//   app: the featured address span is escaped
//   reconcile: balances sum across accounts of one mint
//   report: totalAssumed equals the sum of its rows
//   reconcile: the drift tolerance stays 1%, not a runaway share

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const OTHER = "Bbbb1111111111111111111111111111111111111111";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const OTHERX = "StockMint2222222222222222222222222222222222";
const MINT12 = "FineMint1111111111111111111111111111111111111";
const MOVEX = "MOVEMint1111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const WSOL = "So11111111111111111111111111111111111111112";

const servers = [];
const children = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const out = handler(msg, req, res);
      if (out === undefined) return; // handler wrote the response itself
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const waitReady = async (base, path_ = "/api/featured") => {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + path_); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

// Jupiter stub: answers a stock tag for the transfer-heavy test mint so it
// never touches the network; everything else answers an empty (no-data) list.
// It writes the raw array itself — lookupToken expects a bare JSON array,
// not a JSON-RPC envelope.
const jup = await stubServer((msg, req, res) => {
  const mint = decodeURIComponent(String(req.url).split("query=")[1] ?? "");
  const items = mint.startsWith("MOVE") ? [{ id: mint, symbol: "MOVEx", tags: ["stocks"] }] : [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(items));
});
process.env.JUP_SEARCH_URL = jup.url;

// offline determinism: SOL history must never reach the price API
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) return Promise.resolve({ ok: false, json: async () => ({}) });
  return realFetch(u, o);
};

const { rpc, allSignatures } = await import("../src/rpc.mjs");
const { tokenDeltas, pairTrades, ingestWallet, DUST_EPS } = await import("../src/ingest.mjs");
const { fifoBasis, perStockSummary, RECONCILE_SYNTHETIC } = await import("../src/basis.mjs");
const { buildReport } = await import("../src/report.mjs");
const { buildReconciledReport, diffAdjustments } = await import("../src/reconcile.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");
const { primeSolDayCache } = await import("../src/price.mjs");

primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(PYUSD, { symbol: "PYUSD", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });
primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
primeTokenCache(OTHERX, { symbol: "OTHERx", name: "", isStock: true, tags: [] });
primeTokenCache(MINT12, { symbol: "FINEx", name: "", isStock: true, tags: [] });

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const c of children) c.kill("SIGKILL");
});

// ---- rpc: pagination ---------------------------------------------------------

test("rpc: a page shorter than the limit is not the end of history", async () => {
  // 250 signatures behind a provider that caps every page at 150: the old
  // walk stopped after page one and silently lost the oldest 100
  const sigs = Array.from({ length: 250 }, (_, i) => `sig${String(i).padStart(4, "0")}`);
  const befores = [];
  const stub = await stubServer((msg) => {
    const before = msg.params[1]?.before;
    befores.push(before ?? null);
    const start = before ? sigs.indexOf(before) + 1 : 0;
    return { result: sigs.slice(start, start + 150).map((signature, i) => ({ signature, slot: start + i, blockTime: 1, err: null })) };
  });
  const seen = [];
  for await (const s of allSignatures(OWNER, { rpcUrl: stub.url })) seen.push(s.signature);
  assert.equal(seen.length, 250, `a short page must not end the walk (got ${seen.length}/250)`);
  assert.equal(new Set(seen).size, 250, "no signature may arrive twice");
  assert.equal(befores[1], sigs[149], "the cursor must be the OLDEST signature of the page");
  assert.equal(befores[2], sigs[249]);
});

test("rpc: a mirror repeating one page terminates the walk", { timeout: 30_000 }, async () => {
  const page = ["s1", "s2", "s3"].map((signature, i) => ({ signature, slot: i, blockTime: 1, err: null }));
  const stub = await stubServer(() => ({ result: page }));
  let n = 0;
  for await (const s of allSignatures(OWNER, { rpcUrl: stub.url })) {
    if (++n > 20) break; // hard cap: a broken walk must not hang the suite
  }
  assert.equal(n, 3, `the repeating page yields exactly once (got ${n})`);
});

// ---- rpc: result:null --------------------------------------------------------

test("rpc: result:null rotates to the mirror that still has the transaction", async () => {
  const aLog = [];
  const bLog = [];
  const a = await stubServer((msg) => { aLog.push(msg.method); return { result: null }; }); // evicted on this mirror
  const b = await stubServer((msg) => { bLog.push(msg.method); return { result: { slot: 42, marker: "real" } }; });
  const res = await rpc("getTransaction", ["sig", {}], { rpcUrl: `${a.url},${b.url}` });
  assert.equal(res?.marker, "real", "the surviving mirror's answer must win");
  // whichever mirror the shared index starts at, a null answer must never be
  // the final word while the other mirror was never asked
  assert.ok(aLog.length === 0 || bLog.length >= 1, "a null answer must be followed by the other mirror");
});

test("rpc: null from every mirror returns null honestly", async () => {
  const a = await stubServer(() => ({ result: null }));
  const b = await stubServer(() => ({ result: null }));
  const res = await rpc("getTransaction", ["sig", {}], { rpcUrl: `${a.url},${b.url}` });
  assert.equal(res, null, "all-mirrors-null is a confirmed hole, expressed as null");
});

// ---- ingest: dust epsilon ----------------------------------------------------

test("ingest: the smallest unit of a 12-decimals mint is a real movement", () => {
  const meta = {
    preTokenBalances: [{ accountIndex: 1, mint: MINT12, owner: OWNER, uiTokenAmount: { uiAmountString: "0", uiAmount: 0 } }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT12, owner: OWNER, uiTokenAmount: { uiAmountString: "0.000000000001", uiAmount: 1e-12 } }],
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.ok(1e-12 >= DUST_EPS, "the smallest 12-decimals unit sits exactly at the shared epsilon");
  assert.equal(deltas.length, 1, `exactly 1e-12 must survive the dust filter (got ${deltas.length})`);
  assert.equal(deltas[0].delta, 1e-12);
});

test("ingest: the pairing net keeps the 12-decimals unit as a trade", async () => {
  const trades = [];
  await pairTrades(
    [{ mint: MINT12, delta: -1e-12 }, { mint: USDC, delta: 1e-12 }],
    { ts: 1, slot: 1, signature: "fine1", solDelta: 0 },
    trades, [],
  );
  assert.equal(trades.length, 1, `the netted epsilon-unit must book (got ${trades.length})`);
  assert.ok(Math.abs(trades[0].qty - 1e-12) < 1e-15);
});

// ---- ingest: SOL proceeds alongside a stable tail ---------------------------

test("ingest: proceeds split between a stable tail and native SOL are priced in full", async () => {
  primeSolDayCache(1_700_000_000, 100);
  const trades = [];
  // sell 5 TSLAx: +50 USDC tail plus +0.5 SOL unwrapped from a temp WSOL
  // account — the old pricer dropped the SOL side whenever any leg existed
  await pairTrades(
    [{ mint: TSLAX, delta: -5 }, { mint: USDC, delta: 50 }],
    { ts: 1_700_000_000, slot: 1, signature: "s1", solDelta: 0.5e9 },
    trades, [],
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the trade must book");
  assert.ok(Math.abs(sell.valueUsd - 100) < 1e-9, `50 USDC + 0.5 SOL at $100 = $100 (got ${sell.valueUsd})`);
});

// ---- ingest: dust sweep of a second stock ------------------------------------

test("ingest: a dust sweep of a second stock must not demote the trade", async () => {
  const trades = [], transfers = [];
  // real sell: 5 TSLAx for 800 USDC; same tx sweeps 3e-9 OTHERx dust out
  await pairTrades(
    [{ mint: TSLAX, delta: -5 }, { mint: OTHERX, delta: -3e-9 }, { mint: USDC, delta: 800 }],
    { ts: 1_700_000_000, slot: 1, signature: "s2", solDelta: 0 },
    trades, transfers,
  );
  const sell = trades.find((t) => t.mint === TSLAX && t.side === "sell");
  assert.ok(sell, "the material leg keeps its cash pairing");
  assert.ok(Math.abs(sell.valueUsd - 800) < 1e-9, `proceeds are $800 (got ${sell.valueUsd})`);
  const dust = trades.find((t) => t.mint === OTHERX);
  assert.equal(dust?.side, "out", "the dust leg books as a disclosed movement");
  assert.equal(dust?.aggregated, true);
  assert.ok(transfers.some((t) => t.mint === OTHERX), "the movement is visible in the ledger");
});

// ---- ingest: PYUSD cash leg --------------------------------------------------

test("ingest: PYUSD is a cash leg, not a withdrawal", async () => {
  const trades = [];
  await pairTrades(
    [{ mint: TSLAX, delta: -5 }, { mint: PYUSD, delta: 600 }],
    { ts: 1_700_000_000, slot: 1, signature: "s3", solDelta: 0 },
    trades, [],
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "a PYUSD sale must book as a sale");
  assert.ok(Math.abs(sell.valueUsd - 600) < 1e-9, `proceeds are $600 (got ${sell.valueUsd})`);
});

// ---- ingest: authority flips -------------------------------------------------

test("ingest: an authority flip books the full account movement both ways", async () => {
  const bal = (owner, amount) => ({ accountIndex: 1, mint: TSLAX, owner, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  const flipOut = tokenDeltas({ preTokenBalances: [bal(OWNER, 5)], postTokenBalances: [bal(OTHER, 5)] }, OWNER);
  assert.equal(flipOut.length, 1, "the flip-out must not vanish");
  assert.equal(flipOut[0].delta, -5, "the whole prior balance is a disposal");
  const flipIn = tokenDeltas({ preTokenBalances: [bal(OTHER, 3)], postTokenBalances: [bal(OWNER, 7)] }, OWNER);
  assert.equal(flipIn.length, 1);
  assert.equal(flipIn[0].delta, 7, "a flip-in deposits the full post balance, not the diff against the old owner");
});

test("ingest: an authority-flip sale with SOL proceeds is not skipped", async () => {
  primeSolDayCache(1_700_000_000, 100);
  const meta = {
    preTokenBalances: [{ accountIndex: 1, mint: TSLAX, owner: OWNER, uiTokenAmount: { uiAmountString: "5", uiAmount: 5 } }],
    postTokenBalances: [{ accountIndex: 1, mint: TSLAX, owner: OTHER, uiTokenAmount: { uiAmountString: "5", uiAmount: 5 } }],
  };
  const trades = [];
  await pairTrades(tokenDeltas(meta, OWNER), { ts: 1_700_000_000, slot: 1, signature: "s4", solDelta: 0.5e9 }, trades, []);
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the disposal and its SOL proceeds must book");
  assert.ok(Math.abs(sell.valueUsd - 50) < 1e-9, `0.5 SOL at $100 = $50 (got ${sell.valueUsd})`);
});

// ---- ingest: cash legs in the ledger -----------------------------------------

test("ingest: cash legs of aggregated and unpriced txs stay in the ledger", async () => {
  const trades = [], transfers = [];
  // two material stocks bought with 600 USDC in one bundle
  await pairTrades(
    [{ mint: TSLAX, delta: 3 }, { mint: OTHERX, delta: 2 }, { mint: USDC, delta: -600 }],
    { ts: 1_700_000_000, slot: 1, signature: "s5", solDelta: 0 },
    trades, transfers,
  );
  assert.ok(transfers.some((t) => t.mint === USDC && t.delta === -600), "the bundle's cash side must not vanish from the ledger");

  const trades2 = [], transfers2 = [];
  // a WSOL sale with no price source: movement, and the WSOL leg stays visible
  await pairTrades(
    [{ mint: TSLAX, delta: -5 }, { mint: WSOL, delta: 0.6 }],
    { ts: 1_600_000_000, slot: 1, signature: "s6", solDelta: 0 },
    trades2, transfers2,
  );
  assert.ok(transfers2.some((t) => t.mint === WSOL && Math.abs(t.delta - 0.6) < 1e-9), "an unpriced WSOL leg must stay in the ledger");
});

// ---- ingest: stop target counts trades only ----------------------------------

test("ingest: the stop target counts buys/sells, never custody movements", async () => {
  const sigs = Array.from({ length: 38 }, (_, i) => ({ signature: `mv${String(i).padStart(3, "0")}`, slot: i + 1, blockTime: 1_700_000_000 - (37 - i) * 60, err: null }));
  const tb = (accountIndex, mint, amount) => ({ accountIndex, mint, owner: OWNER, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  const movementTx = { transaction: { message: { accountKeys: [{ pubkey: OWNER }] } }, meta: { preTokenBalances: [], postTokenBalances: [tb(1, MOVEX, 1)], preBalances: [1e9], postBalances: [1e9], fee: 0 } };
  const buyTx = { transaction: { message: { accountKeys: [{ pubkey: OWNER }] } }, meta: { preTokenBalances: [tb(2, USDC, 10_000)], postTokenBalances: [tb(1, MOVEX, 5), tb(2, USDC, 9_400)], preBalances: [1e9], postBalances: [1e9], fee: 0 } };
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: sigs };
    const idx = sigs.findIndex((s) => s.signature === msg.params[0]);
    return { result: idx >= 0 && idx >= 35 ? buyTx : movementTx };
  });
  // 35 movements precede the 3 buys; target 30 must not stall on the movements
  const { trades, seen } = await ingestWallet(OWNER, { rpcUrl: stub.url, targetStockTrades: 30, maxScanTx: 100 });
  const buys = trades.filter((t) => t.side === "buy");
  assert.equal(buys.length, 3, `all three buys must be found (got ${buys.length})`);
  assert.equal(seen, 38, `the whole chain is walked (seen ${seen})`);
});

// ---- basis: activity window --------------------------------------------------

test("basis: reconcile synthetics stay out of the activity window", () => {
  const T = 1_700_000_000;
  const row = perStockSummary(new Map([[TSLAX, [
    { side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: T, slot: 1 },
    { side: "out", mint: TSLAX, qty: 5, valueUsd: 0, ts: T + 90 * 86400, slot: 1, signature: RECONCILE_SYNTHETIC },
  ]]]), () => ({ symbol: "TSLAx", name: "" }))[0];
  assert.equal(row.lastTs, T, `the window ends at the last REAL trade (got ${row.lastTs})`);
});

// ---- server ------------------------------------------------------------------

const tmpRepo = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-r8-"));
  for (const d of ["src", "web", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await cp(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
};

const pollJob = async (base, id) => {
  for (let i = 0; i < 150; i++) {
    const j = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
};

test("server: an empty env number falls back to the default, not zero", async () => {
  const dir = await tmpRepo();
  const T = 1_700_000_000;
  const tb = (accountIndex, mint, amount) => ({ accountIndex, mint, owner: OWNER, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  const buyTx = { transaction: { message: { accountKeys: [{ pubkey: OWNER }] } }, meta: { preTokenBalances: [tb(2, USDC, 1000)], postTokenBalances: [tb(1, TSLAX, 5), tb(2, USDC, 500)], preBalances: [1e9], postBalances: [1e9], fee: 0 } };
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "5" } } } } } }] } };
    return { result: [] };
  });
  const port = 22000 + Math.floor(Math.random() * 20000);
  // INGEST_TARGET_TRADES="" parsed via bare Number() is 0: the scan stopped
  // before its first tx and every report came back instantly empty
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), SOLANA_RPC: stub.url, JUP_SEARCH_URL: jup.url, INGEST_TARGET_TRADES: "", STOCKBASIS_NO_FEATURED: "1", STOCKBASIS_NO_MARKET: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  try {
    const { id } = await (await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: OWNER }) })).json();
    const job = await pollJob(base, id);
    assert.equal(job.status, "done");
    assert.ok(job.result.rows.length >= 1, `the chain's real buy must be in the report (got ${job.result.rows.length} rows)`);
  } finally { child.kill("SIGKILL"); }
});

test("server: featured precompute reconciliation rides PRECOMPUTE_RPC", async () => {
  const dir = await tmpRepo();
  const A = "Caaa1111111111111111111111111111111111111111";
  await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: A, label: "day trader" }]));
  const T = 1_700_000_000;
  const tb = (accountIndex, mint, amount) => ({ accountIndex, mint, owner: A, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  const buyTx = { transaction: { message: { accountKeys: [{ pubkey: A }] } }, meta: { preTokenBalances: [tb(2, USDC, 1000)], postTokenBalances: [tb(1, TSLAX, 5), tb(2, USDC, 500)], preBalances: [1e9], postBalances: [1e9], fee: 0 } };
  const precomputeLog = [];
  const interactiveLog = [];
  const precompute = await stubServer((msg) => {
    precomputeLog.push(msg.method);
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "5" } } } } } }] } };
    return { result: [] };
  });
  const interactive = await stubServer((msg) => {
    interactiveLog.push(msg.method);
    return { result: [] };
  });
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), SOLANA_RPC: interactive.url, PRECOMPUTE_RPC: precompute.url, JUP_SEARCH_URL: jup.url, STOCKBASIS_NO_MARKET: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  try {
    for (let i = 0; i < 150 && !precomputeLog.includes("getTokenAccountsByOwner"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(precomputeLog.includes("getTokenAccountsByOwner"), "the reconciliation must run in the background round");
    assert.equal(interactiveLog.length, 0, `the interactive endpoint must stay untouched by the background round (got ${interactiveLog})`);
  } finally { child.kill("SIGKILL"); }
});

test("server: /api/featured serves only validated entries", async () => {
  const dir = await tmpRepo();
  const good = "Daaa1111111111111111111111111111111111111111";
  await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([
    { address: good, label: "ok" },
    { label: "no address here" },
    { address: "not base58!", label: "broken" },
  ]));
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), STOCKBASIS_NO_FEATURED: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  try {
    const list = await (await fetch(base + "/api/featured")).json();
    assert.equal(list.length, 1, `only the valid entry may ship to the client (got ${JSON.stringify(list)})`);
    assert.equal(list[0].address, good);
  } finally { child.kill("SIGKILL"); }
});

// ---- web/app.js (DOM sandbox) ------------------------------------------------

const appCode = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const runApp = (fetchImpl, extraGlobal = {}) => {
  const els = {};
  const el = (id) => els[id] ??= {
    hidden: false, textContent: "", innerHTML: "", className: "", title: "", style: {}, value: "", checked: false, dataset: {},
    listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    requestSubmit() { this.listeners.submit?.({ preventDefault() {} }); },
  };
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
    console, Math, JSON, Number, String, Date, Object, Array, RegExp, Promise, isFinite,
    setTimeout, clearTimeout, AbortSignal, Intl,
    ...extraGlobal,
  };
  vm.runInNewContext(appCode, sandbox);
  return { els, blobs, downloads };
};
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

const doneJob = () => ({
  id: "j1", address: OWNER, status: "done", progress: 1, trades: 1, phase: "done", error: null,
  result: {
    rows: [{ mint: TSLAX, symbol: "TSLAx", name: "", trades: 1, buys: 1, sells: 0, wins: 1, losses: 0, unknownBasis: 0, realizedUsd: 100, realizedAssumed: 0, openQty: 1, openUnknownQty: 0, openCostUsd: 10, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }],
    totalRealized: 100, totalAssumed: 0, tokens: 1, unknownBasis: 0, coverage: null, disposals: [],
  },
});

test("app: a JSON body without a job shape is a blip, never 'Scanned undefined'", async () => {
  let gets = 0;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    if (String(url).includes("/api/jobs/")) {
      gets++;
      return jsonRes(gets === 1 ? { message: "gateway ok" } : doneJob());
    }
    return jsonRes([]);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!/undefined/.test(els["progress-text"].textContent), `the progress line must stay honest (got "${els["progress-text"].textContent}")`);
  assert.ok(!/NaN/.test(String(els["bar-fill"].style.width)), "the bar must not compute a NaN width");
  await new Promise((r) => setTimeout(r, 2600)); // the blip backoff, then the good answer
  assert.equal(els.report.hidden, false, "the poll recovers once real answers resume");
});

test("app: a hanging poll request is aborted and retried", async () => {
  let gets = 0;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    if (String(url).includes("/api/jobs/")) {
      gets++;
      // a fetch stub must honor the abort signal exactly like the real one:
      // the hang ends when (and because) app.js aborts it
      if (gets === 1) return new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return jsonRes(doneJob());
    }
    return jsonRes([]);
  }, { STOCKBASIS_REQ_TIMEOUT_MS: 200 });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 2800));
  assert.ok(gets >= 2, `the hang must abort into a retry (made ${gets} GETs)`);
  assert.equal(els.report.hidden, false, "the scan completes after the hang clears");
});

test("app: the featured address span is escaped", async () => {
  const { els } = runApp(() => jsonRes([{ label: "hostile", address: "<img src=x onerror=alert(1)>" }]));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(els.featured.hidden, false, "precondition: the strip rendered");
  assert.ok(!/<img/.test(els["featured-list"].innerHTML), `markup must not enter the DOM raw (got ${els["featured-list"].innerHTML})`);
  assert.ok(els["featured-list"].innerHTML.includes("&lt;img"), "the address renders escaped");
});

// ---- reconcile / report invariants -------------------------------------------

test("reconcile: the balance read sums every account of one mint", async () => {
  const stub = await stubServer(() => ({
    result: { value: [
      { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "5" } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "7" } } } } } },
    ] },
  }));
  const trades = [{ side: "buy", mint: TSLAX, qty: 12, valueUsd: 1200, ts: 1_700_000_000, slot: 1 }];
  const { report, reconciled } = await buildReconciledReport(OWNER, trades, { rpcUrl: stub.url });
  const row = report.rows.find((r) => r.mint === TSLAX);
  assert.equal(reconciled, 0, "5 + 7 across two ATAs agrees with the claimed 12 — no adjustment");
  assert.ok(Math.abs(row.openQty - 12) < 1e-9, `the position stands (openQty=${row.openQty})`);
});

test("report: totalAssumed equals the sum of its rows", async () => {
  const T = 1_700_000_000;
  const report = await buildReport([
    { side: "in", mint: TSLAX, qty: 10, valueUsd: 0, ts: T, slot: 1 },
    { side: "sell", mint: TSLAX, qty: 10, valueUsd: 5000, ts: T + 3600, slot: 2, marketPx: 400, marketPxAt: T + 7200 },
  ]);
  const rowsSum = Math.round(report.rows.reduce((s, r) => s + (r.realizedAssumed ?? 0), 0) * 100) / 100;
  assert.equal(report.totalAssumed, rowsSum, `the headline must reconcile with its own rows (${report.totalAssumed} vs ${rowsSum})`);
  assert.ok(Math.abs(report.totalAssumed - 1000) < 1e-9, `10 sold at $500 vs $400 market = +$1000 assumed (got ${report.totalAssumed})`);
  assert.equal(report.totalRealized, 0, "known-basis P&L stays zero");
});

test("reconcile: the drift tolerance stays 1% — a 5% gap is a phantom", () => {
  const M = "Phantom11111111111111111111111111111111111111";
  const adj = diffAdjustments([{ mint: M, openQty: 4, openUnknownQty: 0 }], new Map([[M, 3.8]]));
  assert.equal(adj.length, 1, "an unseen 5% sale must surface as an adjustment");
  assert.ok(Math.abs(adj[0].diff + 0.2) < 1e-9, `diff is exactly the missing 0.2 (got ${adj[0].diff})`);
  const none = diffAdjustments([{ mint: M, openQty: 4, openUnknownQty: 0 }], new Map([[M, 3.97]]));
  assert.equal(none.length, 0, "a 1% in-flight drift stays tolerated");
});
