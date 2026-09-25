// Regression tests for polish round 72 (lifecycle and concurrency). Every
// test pins one proven vector:
//   server: precompute carry-over forgets wallets removed from featured.json
//   server: stocks.json = null degrades /api/stats, not the socket
//   classify: the token cache is bounded and truncates issuer metadata
//   server: a duplicate of a running scan joins it even at a full board
//   ingest: INGEST_CONCURRENCY=0 clamps to 1 instead of starving the loop
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped

const servers = [];
const children = [];
after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const c of children) c.kill("SIGKILL");
});

const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"), req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};

const tmpRepo = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-r72-"));
  for (const d of ["src", "web", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await cp(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
};

const waitReady = async (base) => {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + "/api/featured"); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const buyTx = (T) => ({
  transaction: { message: { accountKeys: [{ pubkey: OWNER }] } },
  meta: {
    preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: OWNER, uiTokenAmount: { uiAmount: 1000, uiAmountString: "1000" } }],
    postTokenBalances: [
      { accountIndex: 1, mint: TSLAX, owner: OWNER, uiTokenAmount: { uiAmount: 5, uiAmountString: "5" } },
      { accountIndex: 2, mint: USDC, owner: OWNER, uiTokenAmount: { uiAmount: 500, uiAmountString: "500" } },
    ],
    preBalances: [1e9], postBalances: [1e9], fee: 0, blockTime: T,
  },
});

const wallet_i = (i) => ("Wa" + String(i).replace(/0/g, "z") + "q").padEnd(38, "p");

test("server: carry-over drops wallets removed from featured.json", async () => {
  const dir = await tmpRepo();
  const T = 1_700_000_000;
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sigA", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(T) };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: OWNER, label: "x" }]), "utf8");
  let stderr = "";
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: {
      ...process.env, PORT: "0",
      SOLANA_RPC: stub.url, PRECOMPUTE_RPC: stub.url,
      PRECOMPUTE_INTERVAL_MIN: "0.002", // ~120 ms rounds
      STOCKBASIS_NO_MARKET: "1", RPC_MAX_RETRIES: "2", RPC_MIN_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  child.stderr.on("data", (c) => { stderr += c; });
  // wait for the wallet to be cached, then remove it and wait for the next round
  const t0 = Date.now();
  while (!/precompute Aaaa1111 cached/.test(stderr) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
  assert.match(stderr, /precompute Aaaa1111 cached/, "the first round must cache the wallet before removal");
  await writeFile(path.join(dir, "data", "featured.json"), "[]", "utf8");
  const t1 = Date.now();
  while (!/precompute round complete: 0 cached/.test(stderr) && Date.now() - t1 < 20_000) await new Promise((r) => setTimeout(r, 100));
  assert.match(stderr, /precompute round complete: 0 cached/, "after removal the map must shrink to zero, not serve the frozen report forever");
});

test("server: stocks.json = null degrades the strip, not the socket", async () => {
  const dir = await tmpRepo();
  await writeFile(path.join(dir, "data", "stocks.json"), "null", "utf8");
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), STOCKBASIS_NO_FEATURED: "1", STOCKBASIS_NO_MARKET: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  const r = await fetch(base + "/api/stats");
  assert.equal(r.status, 200, "a null stocks.json must answer an empty strip, not destroy the socket");
  const s = await r.json();
  assert.equal(s.trackedTokens, 0);
});

test("classify: the token cache is bounded and truncates issuer metadata", async () => {
  // Jupiter search stub: one unknown mint with hostile 300-char metadata
  const jup2 = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: "UnknownMint1111111111111111111111111111111", symbol: "A".repeat(300), name: "B".repeat(300), tags: ["stocks"] }]));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  process.env.JUP_SEARCH_URL = `${jup2.url}/search`;
  const classify = await import("../src/classify.mjs");
  // cap: priming past MAX must evict, not grow without bound
  for (let i = 0; i < 1100; i++) classify.primeTokenCache(`CapMint${String(i).replace(/0/g, "z")}${"q".padEnd(30, "p")}`, { symbol: "C", name: "", isStock: false, tags: [] });
  assert.ok(classify.tokenCacheSize() <= 1024, `cache must stay bounded, got ${classify.tokenCacheSize()}`);
  // truncation: a hostile mint cannot park megabytes in symbol/name
  const meta = await classify.lookupToken("UnknownMint1111111111111111111111111111111");
  assert.ok(meta, "the stub answered");
  assert.ok(meta.symbol.length <= 64, `symbol must be clipped, got ${meta.symbol.length}`);
  assert.ok(meta.name.length <= 128, `name must be clipped, got ${meta.name.length}`);
  assert.equal(meta.isStock, true);
});

test("server: a duplicate of a running scan joins it at a full board", async () => {
  const dir = await tmpRepo();
  const stub = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        if (msg.method === "getSignaturesForAddress") {
          // hold every scan in the signature phase long enough to fill the board
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
          }, 4000);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), SOLANA_RPC: stub.url, STOCKBASIS_NO_FEATURED: "1", STOCKBASIS_NO_MARKET: "1", RPC_MAX_RETRIES: "2", RPC_MIN_INTERVAL_MS: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  const post = (address) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) }).then((r) => ({ status: r.status, body: r.json() }));
  const firsts = [];
  for (let i = 1; i <= 20; i++) firsts.push(await post(wallet_i(i)));
  for (const f of firsts) assert.equal(f.status, 202);
  const dup = await post(wallet_i(1));
  assert.equal(dup.status, 202, "a join of an already-running scan is zero new load — it must not answer a lying 503");
  const dupId = (await dup.body).id;
  const origId = (await firsts[0].body).id;
  assert.equal(dupId, origId, "the duplicate must join the running job, not start a 21st");
});

test("ingest: INGEST_CONCURRENCY=0 clamps to 1 instead of a zombie loop", async () => {
  const dir = await tmpRepo();
  const T = 1_700_000_000;
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sigZ", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(T) };
    return { result: [] };
  });
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), SOLANA_RPC: stub.url, INGEST_CONCURRENCY: "0", STOCKBASIS_NO_FEATURED: "1", STOCKBASIS_NO_MARKET: "1", RPC_MAX_RETRIES: "2", RPC_MIN_INTERVAL_MS: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitReady(base), "server child did not come up");
  const start = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: OWNER }) });
  assert.equal(start.status, 202);
  // with i += 0 every timer and accept starves — but the scan spends its first
  // moments in network awaits, so the check must come AFTER the walk hands
  // over to the spinning loop, not before it
  const alive1 = await fetch(base + "/api/featured", { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
  assert.ok(alive1, "the server must answer while the scan is still in its network phase");
  await new Promise((r) => setTimeout(r, 1500));
  const alive2 = await fetch(base + "/api/featured", { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
  assert.ok(alive2, "the event loop must keep serving even once the scan reaches its walk loop");
});
