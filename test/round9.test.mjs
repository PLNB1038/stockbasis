// Regression tests for polish round 9. Every test pins one proven vector:
//   fixture: stats-child exits when run by the test runner, not a spawn
//   ingest: a hostile Infinity uiAmount is an unreadable balance, not a trade
//   ingest: an unreadable pre-balance is a hole, not a phantom deposit
//   ingest: the stable half of a trade survives an SOL price outage
//   ingest: rent refunded by closed token accounts is not sale proceeds
//   rpc: env numbers pass the finite-or-default gate (NaN must not wedge pacing)
//   rpc: an empty SOLANA_RPC override falls through to the default list
//   classify: an empty CLASSIFY_NULL_TTL_MS keeps the no-data cache warm
//   app: {status:"running"} without numbers is a blip, not "Scanned undefined"
//   server: json responses carry Cache-Control: no-store
//   csv/ui: the smallest unit of a 12-decimals mint prints as itself

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const OTHER = "Bbbb1111111111111111111111111111111111111111";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const MINT12 = "FineMint1111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

// offline determinism: SOL history must never reach the price API
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) return Promise.resolve({ ok: false, json: async () => ({}) });
  return realFetch(u, o);
};

const { tokenDeltas, pairTrades } = await import("../src/ingest.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");
const { primeSolDayCache } = await import("../src/price.mjs");
const { toCsv } = await import("../src/csv.mjs");

primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });
primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
primeTokenCache(MINT12, { symbol: "FINEx", name: "", isStock: true, tags: [] });

const servers = [];
const children = [];
const plainStub = (handler) => {
  const server = http.createServer((req, res) => handler(req, res));
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const runChild = async (args, env, timeoutMs = 20_000) => {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const verdict = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("TIMEOUT"); }, timeoutMs);
    child.on("exit", (code, signal) => { clearTimeout(t); resolve(code ?? `signal:${signal}`); });
  });
  return { verdict, out };
};

after(() => {
  for (const c of children) try { c.kill("SIGKILL"); } catch { /* already gone */ }
  for (const s of servers) try { s.close(); } catch { /* already closed */ }
});

// ---- fixture guard ----------------------------------------------------------

test("fixture: stats-child exits when run by the test runner instead of a spawn", async () => {
  // the runner executes every .mjs under test/, fixtures included; without the
  // guard this helper imports a server that never exits and hangs npm test
  const child = spawn(process.execPath, [path.join("test", "fixtures", "stats-child.mjs")], {
    cwd: ROOT,
    env: { ...process.env, SB_FIXTURE_SPAWNED: "" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const verdict = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve("HUNG"); }, 5000);
    child.on("exit", (code) => { clearTimeout(t); resolve(code); });
  });
  assert.notEqual(verdict, "HUNG", "the runner's copy of the fixture must exit, not hang the whole run");
  assert.equal(verdict, 0, `a clean exit was expected (got ${verdict})`);
});

// ---- ingest: hostile / unreadable balances ----------------------------------

test("ingest: a hostile Infinity uiAmount is an unreadable balance, not a trade", () => {
  const meta = {
    preTokenBalances: [{ mint: TSLAX, owner: OWNER, accountIndex: 1, uiTokenAmount: { uiAmount: 5, uiAmountString: "5", decimals: 6 } }],
    postTokenBalances: [{ mint: TSLAX, owner: OWNER, accountIndex: 1, uiTokenAmount: { uiAmount: Infinity, uiAmountString: "1e999", decimals: 6 } }],
  };
  assert.deepEqual(tokenDeltas(meta, OWNER), [], "an unreadable balance must not become an Infinity delta");
});

test("ingest: an unreadable pre-balance is a hole, not a phantom deposit", () => {
  const garbage = { uiAmount: null, uiAmountString: "garbage" };
  const meta = {
    preTokenBalances: [{ mint: TSLAX, owner: OWNER, accountIndex: 1, uiTokenAmount: garbage }],
    postTokenBalances: [{ mint: TSLAX, owner: OWNER, accountIndex: 1, uiTokenAmount: { uiAmount: 2, uiAmountString: "2" } }],
  };
  assert.deepEqual(tokenDeltas(meta, OWNER), [], "5→2 with an unreadable pre must skip, not book a +2 deposit");
  // a flip-in is different: the account became ours, so the full post balance
  // IS the deposit — the previous owner's unreadable value must not lose it
  const flip = {
    preTokenBalances: [{ mint: TSLAX, owner: OTHER, accountIndex: 1, uiTokenAmount: garbage }],
    postTokenBalances: [{ mint: TSLAX, owner: OWNER, accountIndex: 1, uiTokenAmount: { uiAmount: 3, uiAmountString: "3" } }],
  };
  assert.deepEqual(tokenDeltas(flip, OWNER), [{ mint: TSLAX, delta: 3 }], "the flip-in still books the whole account");
});

// ---- ingest: SOL price outage and rent ---------------------------------------

test("ingest: the stable half of a trade survives an SOL price outage", async () => {
  const ts = 1735900000; // a day with no seeded price; the offline fetch stub answers !ok
  const trades = [];
  const transfers = [];
  await pairTrades(
    [
      { mint: TSLAX, delta: -5 },
      { mint: USDC, delta: 100 },
    ],
    { ts, slot: 1, signature: "soloutage", solDelta: 0.05e9, closedAta: 0 },
    trades,
    transfers,
  );
  assert.equal(trades.length, 1, "the trade must book, priced by its stable leg");
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].valueUsd, 100, "known USDC proceeds must not be dropped along with the unpriced SOL tail");
  assert.ok(transfers.some((t) => t.mint === WSOL && Math.abs(t.delta - 0.05) < 1e-9), "the unpriced native tail still lands in the ledger");
});

test("ingest: rent refunded by closed token accounts is not sale proceeds", async () => {
  const ts = 1736100000;
  primeSolDayCache(ts, 200); // SOL at $200 for the whole day
  const trades = [];
  await pairTrades(
    [
      { mint: TSLAX, delta: -5 },
      { mint: USDC, delta: 500 },
    ],
    { ts, slot: 1, signature: "rent6", solDelta: 0.012264e9, closedAta: 6 },
    trades,
    [],
  );
  assert.equal(trades.length, 1);
  assert.equal(trades[0].valueUsd, 500, `six closed ATAs' rent must not inflate proceeds (got ${trades[0].valueUsd})`);
  // a real native tail still prices — net of one account's refund estimate
  const t2 = [];
  await pairTrades(
    [
      { mint: TSLAX, delta: -5 },
      { mint: USDC, delta: 500 },
    ],
    { ts, slot: 2, signature: "rent1", solDelta: 0.05e9, closedAta: 1 },
    t2,
    [],
  );
  assert.ok(Math.abs(t2[0].valueUsd - (500 + (0.05 - 0.0021) * 200)) < 0.01, `the tail must price net of rent (got ${t2[0].valueUsd})`);
});

// ---- rpc / classify: env numbers through the gate (child processes) --------

test("rpc: env numbers pass the finite-or-default gate — a typo must not disable pacing", async () => {
  const stub = await plainStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { version: "x" } }));
  });
  const url = JSON.stringify(stub.url);
  const code = `
    const { rpc, rpcEndpoints } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src/rpc.mjs")).href)});
    const t0 = Date.now();
    await rpc("getVersion", [], { rpcUrl: ${url} });
    await rpc("getVersion", [], { rpcUrl: ${url} });
    await rpc("getVersion", [], { rpcUrl: ${url} });
    console.log(JSON.stringify({ ms: Date.now() - t0, cur: rpcEndpoints({ rpcUrl: "" }).current }));
  `;
  const { verdict, out } = await runChild(["--input-type=module", "-e", code], { RPC_MIN_INTERVAL_MS: "1x", SOLANA_RPC: "" });
  assert.equal(verdict, 0, `child exited cleanly (got ${verdict})`);
  const { ms, cur } = JSON.parse(out.trim().split("\n").pop());
  // "1x" must fall back to the 120ms default: NaN would compare false forever
  // and one mirror's 429 could then wedge the serialized queue permanently
  assert.ok(ms >= 200, `pacing must survive a typo'd env var (3 calls took ${ms}ms)`);
  // an empty SOLANA_RPC is "no override": the default list answers, not fetch("")
  assert.equal(cur, "https://api.mainnet-beta.solana.com", `an empty override must fall through to the default (got ${cur})`);
});

test("classify: an empty CLASSIFY_NULL_TTL_MS keeps the no-data cache warm", async () => {
  let hits = 0;
  const jup = await plainStub((req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]"); // "no data" — cached with the null TTL
  });
  const code = `
    const { lookupToken } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src/classify.mjs")).href)});
    const M = "DeadMint1111111111111111111111111111111111";
    await lookupToken(M);
    await lookupToken(M);
    await lookupToken(M);
  `;
  const { verdict } = await runChild(["--input-type=module", "-e", code], { JUP_SEARCH_URL: jup.url, CLASSIFY_NULL_TTL_MS: "" });
  assert.equal(verdict, 0, `child exited cleanly (got ${verdict})`);
  // "" parses to a finite 0 and would expire the cache instantly: every repeat
  // lookup would hit Jupiter again, silently stretching scans and quota
  assert.equal(hits, 1, `the no-data answer must be cached at the default TTL (made ${hits} calls)`);
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
    ...extraGlobal,
  };
  vm.runInNewContext(appCode, sandbox);
  return { els };
};
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

const doneJob = () => ({
  id: "j1", address: OWNER, status: "done", progress: 1, trades: 1, phase: "done", error: null,
  result: {
    rows: [{ mint: TSLAX, symbol: "TSLAx", name: "", trades: 1, buys: 1, sells: 0, wins: 1, losses: 0, unknownBasis: 0, realizedUsd: 100, realizedAssumed: 0, openQty: 1, openUnknownQty: 0, openCostUsd: 10, firstTs: 1, lastTs: 2, closes: [], unknownCloses: [] }],
    totalRealized: 100, totalAssumed: 0, tokens: 1, unknownBasis: 0, coverage: null, disposals: [],
  },
});

test("app: {status:'running'} without numbers is a blip, not 'Scanned undefined'", async () => {
  let gets = 0;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    if (String(url).includes("/api/jobs/")) {
      gets++;
      // a lying gateway that answers 200-OK JSON with a bare status string —
      // checking status alone lets it through and reproduces the eternal poll
      return jsonRes(gets === 1 ? { status: "running" } : doneJob());
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

// ---- server: no-store on json responses --------------------------------------

test("server: json responses carry Cache-Control: no-store", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STOCKBASIS_NO_FEATURED: "1", SB_FIXTURE_SPAWNED: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(base + "/api/featured"); if (r.ok) up = true; } catch { /* not up yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, "server child did not come up");
  const r = await fetch(base + "/api/jobs", { method: "POST", body: '{"address":"nope"}', headers: { "Content-Type": "application/json" } });
  assert.equal(r.status, 400, "the invalid address is rejected");
  assert.equal(r.headers.get("cache-control"), "no-store", "a stale proxy must not replay job bodies to the poll loop");
});

// ---- csv / ui: the 12-decimals unit prints as itself ---------------------------

const fnFromBody = (name, arg) => {
  const appSrc = appCode;
  const body = appSrc.match(new RegExp(`const ${name} = \\(${arg}\\) => (.+);$`, "m"))[1];
  return new Function(arg, body.startsWith("{") ? body : `return (${body});`);
};

test("csv/ui: the smallest unit of a 12-decimals mint prints as itself", () => {
  const line = toCsv([{ symbol: "FINEx", mint: MINT12, acquiredTs: 1, soldTs: 2, qty: 1e-12, proceedsUsd: 0.01, costUsd: null, pnlUsd: null }]);
  assert.ok(line.includes(",0.000000000001,"), `the CSV must print the booked unit, not a 0 (${line})`);
  const fmtQty = fnFromBody("fmtQty", "q");
  assert.equal(fmtQty(1e-12), "0.000000000001", "the UI must print the booked unit, not a 0");
});
