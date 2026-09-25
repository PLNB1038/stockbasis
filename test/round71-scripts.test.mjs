// Regression tests for polish round 71 (scripts zone: SB26 + SB21). Every test
// pins one confirmed vector:
//   featured-traders: getTransaction asks version 1 (the ingest.mjs rule) and a
//     failed signature read is an announced skip, never a silent null
//   verify-open-positions: an empty account list from one mirror is INCOMPLETE,
//     never a phantom verdict (the reconcile.mjs rule: one mirror's empty is
//     not a fact) — cross-checked when another mirror exists, skipped otherwise
//   verify-open-positions: a present-but-zero balance is still compared — the
//     phantom verdict stands for a true zero with data behind it
//   verify-open-positions: an empty answer confirmed by the other mirror is a
//     two-mirror zero — the phantom verdict stands there too

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = 1_700_000_000;
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TRADER = "Cccc1111111111111111111111111111111111111111";
const POOL = "Pooo1PoolPair1111111111111111111111111111111"; // any non-trader string: the stub validates nothing
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

// Jupiter stub: the curated mints in data/stocks.json cover the fixtures, but
// the stub guarantees the child processes never touch the real network.
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
const balanceN = (n) => ({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: String(n), uiAmount: n } } } } } }] } });
const held5 = balanceN(5);
const zeroHeld = balanceN(0);

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

// ---- featured-traders: version-1 reads + announced skips -----------------------

test("featured-traders: version-1 reads still rank, and a failed signature read is an announced skip", { timeout: 30_000 }, async () => {
  const stocks = JSON.parse(readFileSync(path.join(ROOT, "data", "stocks.json"), "utf8"));
  const sym = Object.values(stocks)[0].symbol;
  const txVersions = [];
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") {
      return { result: [
        { signature: "sig-alive", slot: 1, blockTime: T, err: null },
        { signature: "sig-dead", slot: 2, blockTime: T, err: null },
      ] };
    }
    if (msg.method === "getTransaction") {
      txVersions.push(msg.params[1]?.maxSupportedTransactionVersion);
      // a version-1 transaction answers -32015 to a version-0 read request
      if (msg.params[0] === "sig-dead") return { error: { code: -32015, message: "unsupported transaction version" } };
      return { result: { transaction: { message: { accountKeys: [
        { pubkey: OWNER, signer: true, writable: false },
        { pubkey: TRADER, signer: true, writable: true },
      ] } }, meta: {} } };
    }
    return { result: [] };
  });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sb-r71-"));
  const preload = path.join(tmp, "dex-pairs.cjs");
  await writeFile(preload, `
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (String(u).includes('dexscreener')) return { ok: true, status: 200, json: async () => [{ chainId: "solana", pairAddress: ${JSON.stringify(POOL)}, liquidity: { usd: 1000 } }] };
      return real(u, o);
    };`);
  try {
    const r = await runNode(["scripts/featured-traders.mjs", sym], { env: { SOLANA_RPC: stub.url, RPC_MAX_RETRIES: "0" }, preload });
    assert.equal(r.code, 0, `the run must survive a failed read (stderr: ${r.err.slice(0, 300)})`);
    assert.ok(r.out.includes(TRADER), `the readable tx's writable signer must still rank (stdout: ${r.out.slice(0, 300)})`);
    assert.ok(txVersions.length >= 2 && txVersions.every((v) => v === 1), `every getTransaction must ask version 1, never 0 (got ${JSON.stringify(txVersions)})`);
    assert.ok(r.err.includes("1 signature read failed"), `the failed read must be counted and announced (stderr: ${r.err.slice(0, 400)})`);
    assert.ok(r.err.includes("skipped, not ranked"), `the announcement must say what was skipped (stderr: ${r.err.slice(0, 400)})`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ---- verify-open-positions: one mirror's empty is not a zero -------------------

test("verify-open-positions: an empty account list from one mirror is INCOMPLETE, never a phantom verdict", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    // 200-OK with an empty list: this mirror simply does not index token
    // accounts — not evidence that the chain holds zero
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  const r = await runNode(["scripts/verify-open-positions.mjs", OWNER], { env: { SOLANA_RPC: stub.url } });
  assert.equal(r.code, 0, `the run still ends cleanly (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes("| INCOMPLETE"), `the address must be marked INCOMPLETE (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("unreadable reads: 1"), `the empty answer counts as an unreadable read (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("empty answer from one mirror — not compared"), `the reason must be spelled out (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(!r.out.includes("phantom"), `a single mirror's empty must never be compared against the claimed qty (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(!r.out.includes("| OK"), `no address may pass verification on one mirror's empty (stdout: ${r.out.slice(0, 400)})`);
});

test("verify-open-positions: an empty answer is cross-checked against the mirror that did not answer", { timeout: 30_000 }, async () => {
  const s1 = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } }; // the mirror that serves the first read
    return { result: [] };
  });
  const s2 = await stubServer((msg) => (msg.method === "getTokenAccountsByOwner" ? held5 : { result: [] }));
  const r = await runNode(["scripts/verify-open-positions.mjs", OWNER], { env: { SOLANA_RPC: `${s1.url},${s2.url}` } });
  assert.equal(r.code, 0, `the run still ends cleanly (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes("| OK"), `the cross-check confirmed 5 — the row must verify, not turn phantom (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("open positions checked: 1"), `the confirmed balance must be compared (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(!r.out.includes("phantom"), `one mirror's empty must not survive as a verdict with another mirror holding 5 (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(!r.out.includes("INCOMPLETE"), `a confirmed read is a fact, not an unreadable (stdout: ${r.out.slice(0, 400)})`);
});

test("verify-open-positions: a present-but-zero balance is still compared — the phantom verdict stands", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    // an account IS listed, its amount is 0: data behind the zero — a fact,
    // not one mirror's word, so it is compared and the mismatch stands
    if (msg.method === "getTokenAccountsByOwner") return zeroHeld;
    return { result: [] };
  });
  const r = await runNode(["scripts/verify-open-positions.mjs", OWNER], { env: { SOLANA_RPC: stub.url } });
  assert.equal(r.code, 0, `the run still ends cleanly (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes("| MISMATCH"), `a true zero with data must still be compared (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("tool holds phantom"), `the phantom verdict must survive for a real zero (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("chain 0.000000"), `the on-chain side of the verdict is the zero (stdout: ${r.out.slice(0, 400)})`);
});

test("verify-open-positions: an empty answer confirmed by the other mirror is a two-mirror zero — phantom stands", { timeout: 30_000 }, async () => {
  const s1 = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: buyTx(OWNER) };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  const s2 = await stubServer((msg) => (msg.method === "getTokenAccountsByOwner" ? { result: { value: [] } } : { result: [] }));
  const r = await runNode(["scripts/verify-open-positions.mjs", OWNER], { env: { SOLANA_RPC: `${s1.url},${s2.url}` } });
  assert.equal(r.code, 0, `the run still ends cleanly (stderr: ${r.err.slice(0, 300)})`);
  assert.ok(r.out.includes("| MISMATCH"), `two agreeing empties are a fact: the phantom verdict stands (stdout: ${r.out.slice(0, 400)})`);
  assert.ok(r.out.includes("tool holds phantom"), `a cross-confirmed zero is compared, not skipped (stdout: ${r.out.slice(0, 400)})`);
});
