// Review-round fixes, pinned one test per confirmed vector:
//   SB12 verify-open-positions: a failed balance read (RPC error or a 200-OK
//     without an account list) is an explicit INCOMPLETE verdict for the
//     address — never a comparison against zero, never a false "tool holds
//     phantom" (the rule reconcile.mjs already enforces on production reports)
//   SB17 reconcile: a single-endpoint empty answer is still trusted by design,
//     but the affected rows now carry singleSource: true — additive disclosure
//     only; trust semantics are unchanged
//   SB17 reconcile: the disclosure marks ONLY the single-endpoint trust path —
//     an empty answer confirmed by a mirror cross-check stays unmarked
//   SB17 reconcile: the disclosure also lands when the trusted zero needs no
//     adjustment (the no-rebuild early return)

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildReconciledReport } from "../src/reconcile.mjs";
import { primeTokenCache } from "../src/classify.mjs";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = 1_700_000_000;
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const OTHER = "Bbbb1111111111111111111111111111111111111111";
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
const held5 = { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "5", uiAmount: 5 } } } } } };

const runNode = async (args, { env = {} } = {}) => {
  const child = spawn(process.execPath, args, {
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

// ---------------------------------------------------------------------------
// SB12: the verifier must not turn a failed balance read into a zero balance

test("verify-open-positions: a failed balance read is an explicit INCOMPLETE, never a phantom verdict", { timeout: 30_000 }, async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") {
      return { result: [{ signature: msg.params[0] === OWNER ? "sigA" : "sigB", slot: 1, blockTime: T, err: null }] };
    }
    if (msg.method === "getTransaction") return { result: buyTx(msg.params[0] === "sigA" ? OWNER : OTHER) };
    if (msg.method === "getTokenAccountsByOwner") {
      // OWNER: an RPC-level error (a permanent code → no retry backoff sleeps)
      if (msg.params[0] === OWNER) return { error: { code: -32602, message: "invalid param: Filter" } };
      // OTHER: a 200-OK with no account list — a failed read, not an empty chain
      return { result: {} };
    }
    return { result: [] };
  });
  const r = await runNode(["scripts/verify-open-positions.mjs", OWNER, OTHER], { env: { SOLANA_RPC: stub.url } });
  assert.equal(r.code, 0, `both wallets still get their own verdict lines (stderr: ${r.err.slice(0, 300)})`);
  assert.equal((r.out.match(/\| INCOMPLETE/g) ?? []).length, 2, `each wallet gets an explicit unreadable verdict (stdout: ${r.out})`);
  assert.equal((r.out.match(/unreadable reads: 1/g) ?? []).length, 2, `the unreadable count is per wallet (stdout: ${r.out})`);
  assert.ok(r.out.includes("balance read failed") && r.out.includes("-32602"), `the RPC error is named, not swallowed (stdout: ${r.out})`);
  assert.ok(r.out.includes("malformed answer"), `the empty-envelope shape is named too (stdout: ${r.out})`);
  assert.ok(!r.out.includes("phantom"), `a failed read must never be compared against zero (stdout: ${r.out})`);
  assert.ok(!r.out.includes("| OK"), `no wallet may pass verification on an unreadable chain (stdout: ${r.out})`);
});

// ---------------------------------------------------------------------------
// SB17: the single-endpoint trusted zero is disclosed on the affected rows

test("reconcile: a single-endpoint trusted zero still wipes the row, and the row now says singleSource", async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } }; // one mirror answers "empty"
    return { result: [] };
  });
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = stub.url; // single-endpoint setup: no mirror to cross-check with
  try {
    primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
    const owner = "Aaaa1111111111111111111111111111111111111111";
    const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }];
    const { report, reconciled, reconcileFailed } = await buildReconciledReport(owner, trades);
    assert.equal(reconciled, 1); // trust semantics unchanged: the zero books the synthetic out
    assert.equal(reconcileFailed, 0);
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty) < 1e-9);
    assert.equal(row.singleSource, true, "the row must disclose that its zero rested on one endpoint's word");
  } finally {
    process.env.SOLANA_RPC = prev;
  }
});

test("reconcile: an empty answer confirmed by another mirror is a cross-checked fact, not singleSource", async () => {
  let calls = 0; // shared across both stubs: the FIRST balance read is empty, later ones hold 5
  const answer = () => {
    calls++;
    return calls === 1 ? { result: { value: [] } } : { result: { value: [held5] } };
  };
  const s1 = await stubServer((msg) => (msg.method === "getTokenAccountsByOwner" ? answer() : { result: [] }));
  const s2 = await stubServer((msg) => (msg.method === "getTokenAccountsByOwner" ? answer() : { result: [] }));
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = `${s1.url},${s2.url}`; // two mirrors: the empty answer gets cross-checked
  try {
    primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
    const owner = "Aaaa1111111111111111111111111111111111111111";
    const trades = [{ side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 }];
    const { report, reconciled } = await buildReconciledReport(owner, trades);
    assert.equal(reconciled, 0); // the cross-check confirmed 5 — no adjustment
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.ok(Math.abs(row.openQty - 5) < 1e-9);
    assert.ok(!("singleSource" in row), "a mirror-verified balance must not be flagged as single-source");
  } finally {
    process.env.SOLANA_RPC = prev;
  }
});

test("reconcile: the singleSource disclosure also lands on the no-adjustment early return", async () => {
  const stub = await stubServer((msg) => {
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  const prev = process.env.SOLANA_RPC;
  process.env.SOLANA_RPC = stub.url;
  try {
    primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
    const owner = "Aaaa1111111111111111111111111111111111111111";
    // the position already nets to zero, so the trusted zero needs no
    // synthetic movement — the disclosure must survive that early return
    const trades = [
      { side: "buy", mint: TSLAX, qty: 5, valueUsd: 500, ts: 100, slot: 1 },
      { side: "sell", mint: TSLAX, qty: 5, valueUsd: 600, ts: 200, slot: 2 },
    ];
    const { report, reconciled } = await buildReconciledReport(owner, trades);
    assert.equal(reconciled, 0);
    const row = report.rows.find((r) => r.mint === TSLAX);
    assert.equal(row.singleSource, true, "disclosure must not depend on an adjustment being booked");
  } finally {
    process.env.SOLANA_RPC = prev;
  }
});
