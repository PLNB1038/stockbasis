// Regression tests for polish round 69. Every test pins one confirmed vector:
//   server: an array-shaped address answers 400, never "passes" the regex
//   server: an object address with toString:null answers 400, not a dead socket
//   server: a late-mounting featured.json is retried and still arms the precompute
//   app: a 502 HTML page from a proxy is a friendly error, not a raw SyntaxError
//   app: a non-JSON POST answer degrades to a friendly line and starts no poll
//   app: a JSON error body still reaches the user verbatim (503 busy)
//   app: a new scan clears the previous wallet's progress digits first
//   app: esc() escapes single quotes too
//   featured-traders: a dexscreener outage skips the symbol, exit 0
//   find-demo-wallet: a non-numeric tail answers usage, never a NaN request body
//   find-demo-wallet: an rpc failure ends in a message, not a stack trace
//   find-demo-wallet: the happy path still ranks a writable signer
//   pick-featured: an all-digit address is an address, never a limit
//   verify-open-positions: one failed wallet costs its own line, not the run

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = 1_700_000_000;
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const OTHER = "Bbbb1111111111111111111111111111111111111111";
const TRADER = "Cccc1111111111111111111111111111111111111111";
const DIGITS = "12345678901234567890123456789012345678901234"; // 44 digits, valid base58 charset
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
});

// Jupiter stub: answers a stock tag for nothing here (the curated mints in
// data/stocks.json cover the fixtures); every lookup gets an empty list so the
// children never touch the network. It writes the bare JSON array itself.
const jup = await stubServer((msg, req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("[]");
});
process.env.JUP_SEARCH_URL = jup.url;

// a minimal wallet buy: 5 TSLAx for 500 USDC, priced on the stable leg
const tb = (accountIndex, mint, owner, amount) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
const buyTx = (owner) => ({
  transaction: { message: { accountKeys: [{ pubkey: owner }] } },
  meta: { preTokenBalances: [tb(2, USDC, owner, 1000)], postTokenBalances: [tb(1, TSLAX, owner, 5), tb(2, USDC, owner, 500)], preBalances: [1e9], postBalances: [1e9], fee: 0 },
});
const balance5 = { result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "5", uiAmount: 5 } } } } } }] } };

const tmpRepo = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-r69-"));
  for (const d of ["src", "web", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await cp(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
};

const runNode = async (args, { env = {}, preload } = {}) => {
  const child = spawn(process.execPath, preload ? ["--require", preload, ...args] : args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return { code, out, err };
};

const spawnServer = async (dir, env = {}) => {
  // below the Windows ephemeral range (49152+) and disjoint from round8's
  // 22000-42000 band, so sibling test files cannot steal the port mid-spawn
  const port = 42000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), JUP_SEARCH_URL: jup.url, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  return { child, base: `http://127.0.0.1:${port}`, stderr: () => err, stdout: () => out };
};

const waitReady = async (base, path_ = "/api/featured") => {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + path_); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

// ---- server: POST /api/jobs address validation --------------------------------

test("server: hostile address shapes answer 400 and the server stays alive", { timeout: 30_000 }, async () => {
  const dir = await tmpRepo();
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [] };
    return { result: [] };
  });
  const { child, base, stderr, stdout } = await spawnServer(dir, { SOLANA_RPC: stub.url, STOCKBASIS_NO_FEATURED: "1" });
  assert.ok(await waitReady(base), `server child did not come up (stderr: ${stderr().slice(0, 400)} stdout: ${stdout().slice(0, 200)})`);
  try {
    const post = (body) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    // an array String()-joins itself into a regex-passing "address": the old
    // check answered 202 and started a job with a corrupted address
    const r1 = await post(JSON.stringify({ address: [OWNER] }));
    assert.equal(r1.status, 400, `an array address must be a 400 (got ${r1.status})`);
    assert.equal((await r1.json()).error, "valid Solana address required");
    // an object with toString:null made ADDRESS_RE.test throw a TypeError that
    // destroyed the socket with no HTTP answer at all
    const r2 = await post(JSON.stringify({ address: { toString: null, x: 1 } }));
    assert.equal(r2.status, 400, `an exotic object address must be a 400 (got ${r2.status})`);
    const r3 = await post(JSON.stringify({ address: OWNER }));
    assert.equal(r3.status, 202, "a valid address still starts a job — the server is alive");
    const r4 = await post(JSON.stringify({ address: [OWNER] }));
    assert.equal(r4.status, 400, "the server keeps answering after a live job");
  } finally { child.kill("SIGKILL"); }
});

// ---- server: featured load retry ---------------------------------------------

test("server: a late-mounting featured.json is retried and still arms the precompute round", { timeout: 30_000 }, async () => {
  const dir = await tmpRepo();
  await rm(path.join(dir, "data", "featured.json")); // the volume has not mounted yet
  const precomputeLog = [];
  const precompute = await stubServer((msg) => {
    precomputeLog.push(msg.method);
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    if (msg.method === "getTokenAccountsByOwner") return balance5;
    return { result: [] };
  });
  const interactive = await stubServer(() => ({ result: [] }));
  const { child, base, stderr, stdout } = await spawnServer(dir, {
    SOLANA_RPC: interactive.url, PRECOMPUTE_RPC: precompute.url, FEATURED_RELOAD_MS: "250", STOCKBASIS_NO_MARKET: "1",
  });
  assert.ok(await waitReady(base), `server child did not come up (stderr: ${stderr().slice(0, 400)} stdout: ${stdout().slice(0, 200)})`);
  try {
    for (let i = 0; i < 100 && !stderr().includes("featured load failed"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(stderr().includes("featured load failed"), "the missed file must be announced, not silently skipped");
    // the volume mounts while the process is already running
    await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: OWNER, label: "late mount" }]));
    for (let i = 0; i < 150 && !precomputeLog.includes("getSignaturesForAddress"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(precomputeLog.includes("getSignaturesForAddress"), `the precompute round must start after the late load (log: ${precomputeLog})`);
  } finally { child.kill("SIGKILL"); }
});

// ---- web/app.js (DOM sandbox) -------------------------------------------------

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

test("app: a 502 HTML page from a proxy is a friendly error, not a raw SyntaxError", async () => {
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") {
      // the proxy's error page: a body no JSON parser can survive
      return { ok: false, status: 502, json: async () => { throw new SyntaxError(`Unexpected token '<', "<html>..." is not valid JSON`); } };
    }
    return jsonRes([]);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(els.error.hidden, false, "the user must see an error, not a silent freeze");
  assert.equal(els.error.textContent, "Server error — please try again (HTTP 502)");
  assert.ok(!/SyntaxError|Unexpected token/.test(els.error.textContent), `the raw parser error must not reach the page (got "${els.error.textContent}")`);
});

test("app: a non-JSON POST answer degrades to a friendly line and starts no poll", async () => {
  let gets = 0;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } };
    if (String(url).includes("/api/jobs/")) { gets++; return jsonRes(doneJob()); }
    return jsonRes([]);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(els.error.textContent, "Server error — please try again.");
  assert.equal(gets, 0, "without a job id no poll may start");
  assert.equal(els.go.disabled, false, "the form must be re-enabled for a retry");
});

test("app: a JSON error body still reaches the user verbatim (503 busy)", async () => {
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ error: "server busy, try again shortly" }, 503);
    return jsonRes([]);
  });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(els.error.textContent, "server busy, try again shortly", "the server's own message must survive the hardening");
});

test("app: a new scan clears the previous wallet's progress digits first", { timeout: 30_000 }, async () => {
  let gets = 0;
  let secondScan = false;
  const { els } = runApp((url, opts) => {
    if (opts?.method === "POST") return jsonRes({ id: "j1" }, 202);
    if (String(url).includes("/api/jobs/")) {
      gets++;
      if (!secondScan) return jsonRes(gets === 1 ? { status: "running", progress: 500, trades: 7, target: 30, phase: "scan" } : doneJob());
      // the new wallet's first poll hangs; the retry gets the finished report.
      // a fetch stub must honor the abort signal exactly like the real one,
      // or the hang never ends and the retry never happens
      return gets === 3
        ? new Promise((_, reject) => { opts?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); })
        : jsonRes(doneJob());
    }
    return jsonRes([]);
  }, { STOCKBASIS_REQ_TIMEOUT_MS: 250 });
  els.address.value = OWNER;
  els.scan.requestSubmit();
  for (let i = 0; i < 100 && els.report.hidden; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(els.report.hidden, false, "precondition: the first scan finished");
  assert.ok(els["progress-text"].textContent.includes("500"), `precondition: stale digits exist (got "${els["progress-text"].textContent}")`);
  assert.ok(els["bar-fill"].style.width && els["bar-fill"].style.width !== "0%", `precondition: the bar holds a stale width (got "${els["bar-fill"].style.width}")`);

  secondScan = true;
  els.scan.requestSubmit();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(els["progress-text"].textContent, "", `the old wallet's digits must not pose as the new scan's progress (got "${els["progress-text"].textContent}")`);
  assert.equal(els["bar-fill"].style.width, "0%", "the bar must start from zero");
  assert.equal(els.progress.hidden, false, "the progress panel is the visible one");
  for (let i = 0; i < 100 && els.report.hidden; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(els.report.hidden, false, "the second scan still completes after the hang clears");
});

test("app: esc() escapes single quotes too", async () => {
  const { els } = runApp(() => jsonRes([{ label: "it's", address: "<img src='x'>aa" }]));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(els.featured.hidden, false, "precondition: the strip rendered");
  assert.ok(els["featured-list"].innerHTML.includes("&#39;"), `the apostrophe must render escaped (got ${els["featured-list"].innerHTML})`);
  assert.ok(!els["featured-list"].innerHTML.includes("'"), "no raw apostrophe may enter the markup");
});

// ---- scripts (spawned, black-box) ---------------------------------------------

test("featured-traders: a dexscreener outage skips the symbol and keeps exit 0", { timeout: 30_000 }, async () => {
  const stocks = JSON.parse(readFileSync(path.join(ROOT, "data", "stocks.json"), "utf8"));
  const sym = Object.values(stocks)[0].symbol;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sb-r69-"));
  const preload = path.join(tmp, "no-dex.cjs");
  await writeFile(preload, "const real = globalThis.fetch;\nglobalThis.fetch = async (u, o) => { if (String(u).includes('dexscreener')) throw new TypeError('429 simulated'); return real(u, o); };");
  try {
    const r = await runNode(["scripts/featured-traders.mjs", sym], { preload });
    assert.equal(r.code, 0, `a provider outage must not kill the run (stderr: ${r.err.slice(0, 200)})`);
    assert.ok(r.err.includes(`(skip ${sym}: dexscreener unavailable`), `the skip must be announced (stderr: ${r.err.slice(0, 300)})`);
    assert.ok(!r.out.includes(`# ${sym}`), "no pool results may print for a skipped symbol");
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("find-demo-wallet: a non-numeric tail answers usage, never a NaN request body", { timeout: 30_000 }, async () => {
  const bad = await runNode(["scripts/find-demo-wallet.mjs", OWNER, "abc"]);
  assert.equal(bad.code, 1, "a garbage txs argument is a usage error");
  assert.ok(bad.err.includes("usage:"), `the usage line must print (stderr: ${bad.err.slice(0, 200)})`);
  const none = await runNode(["scripts/find-demo-wallet.mjs"]);
  assert.equal(none.code, 1);
  assert.ok(none.err.includes("usage:"), "no arguments is a usage error too");
});

test("find-demo-wallet: an rpc failure ends in a message, not a stack trace", { timeout: 30_000 }, async () => {
  const strict = await stubServer(() => ({ error: { code: -32602, message: "Invalid param" } }));
  const r = await runNode(["scripts/find-demo-wallet.mjs", OWNER, "5"], { env: { SOLANA_RPC: strict.url } });
  assert.equal(r.code, 1, "the run reports failure through its exit code");
  assert.ok(r.err.includes("[find-demo]") && r.err.includes("failed"), `a one-line message must print (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(!r.out.includes("Top candidate"), "no results may print for a failed run");
});

test("find-demo-wallet: the happy path still ranks a writable signer", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: 1, err: null }] };
    return { result: { transaction: { message: { accountKeys: [
      { pubkey: OWNER, signer: true, writable: false },
      { pubkey: TRADER, signer: true, writable: true },
    ] } }, meta: {} } };
  });
  const r = await runNode(["scripts/find-demo-wallet.mjs", OWNER, "5"], { env: { SOLANA_RPC: stub.url } });
  assert.equal(r.code, 0, `the happy path must survive the hardening (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes(TRADER), `the writable signer must rank (stdout: ${r.out.slice(0, 300)})`);
});

test("pick-featured: an all-digit address is an address, never a limit", { timeout: 30_000 }, async () => {
  let last = "";
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") { last = msg.params[0]; return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] }; }
    if (msg.method === "getTransaction") return { result: buyTx(last) };
    if (msg.method === "getTokenAccountsByOwner") return balance5;
    return { result: [] };
  });
  // a bare digits-only argument used to become maxScanTx: the address list
  // went empty and the script silently did nothing
  const digits = await runNode(["scripts/pick-featured.mjs", DIGITS], { env: { SOLANA_RPC: stub.url } });
  assert.equal(digits.code, 0, `exit 0 (stderr: ${digits.err.slice(0, 200)})`);
  assert.ok(digits.out.includes(DIGITS), `the digits-only address must be scanned (stdout: ${digits.out.slice(0, 200)})`);
  assert.ok(!digits.out.includes("ERROR"), `the scan must succeed, not error (stdout: ${digits.out.slice(0, 300)})`);
  // a short numeric tail is still the scan cap
  const capped = await runNode(["scripts/pick-featured.mjs", OTHER, "5"], { env: { SOLANA_RPC: stub.url } });
  assert.equal(capped.code, 0);
  assert.ok(capped.out.includes(OTHER) && !capped.out.includes("ERROR"), `a short limit still works (stdout: ${capped.out.slice(0, 200)})`);
});

test("verify-open-positions: one failed wallet costs its own line, not the run", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") {
      if (msg.params[0] === OTHER) return { error: { code: -32602, message: "invalid pubkey" } };
      return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    }
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    if (msg.method === "getTokenAccountsByOwner") return balance5;
    return { result: [] };
  });
  const r = await runNode(["scripts/verify-open-positions.mjs", OTHER, OWNER], { env: { SOLANA_RPC: stub.url } });
  assert.equal(r.code, 0, `the healthy wallet must still be verified (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes(`${OTHER.slice(0, 8)}… | ERROR`), `the failed wallet gets its own verdict line (stdout: ${r.out.slice(0, 300)})`);
  assert.ok(r.out.includes(`${OWNER.slice(0, 8)}… | rows 1`) && r.out.includes("| OK"), `the healthy wallet is verified (stdout: ${r.out.slice(0, 400)})`);
});
