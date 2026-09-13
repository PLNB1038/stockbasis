// The world-is-evil harness: run the FULL pipeline against a fake Solana RPC
// under different world behaviors and demand the outcome contract —
// either a correct report, or an honest error. Never a plausible-looking lie.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ingestWallet } from "../src/ingest.mjs";
import { fifoBasis } from "../src/basis.mjs";
import { primeTokenCache } from "../src/classify.mjs";
import { primeSolDayCache } from "../src/price.mjs";

// offline determinism: seed cash-leg tokens so no test ever touches Jupiter
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
primeTokenCache(USDC_MINT, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL_MINT, { symbol: "WSOL", name: "", isStock: false, tags: [] });
process.env.STOCKBASIS_NO_MARKET ??= "1"; // no live market lookup in tests

const OWNER = "Aaaa1111111111111111111111111111111111111111";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// a small healthy history: buy 1.0, buy 0.5, sell 0.8
function history() {
  const t = Math.floor(Date.now() / 1000) - 3 * 3600;
  let tslax = 0, usdc = 0, slot = 1000;
  const sigs = [], txs = new Map();
  for (const st of [
    { ts: t, dTslax: 1.0, dUsdc: -250 },
    { ts: t + 3600, dTslax: 0.5, dUsdc: -125 },
    { ts: t + 7200, dTslax: -0.8, dUsdc: 210 },
  ]) {
    slot += 10;
    const sig = `Sig${String(slot).padStart(6, "0")}${"q".repeat(30)}`;
    const preT = tslax, preU = usdc;
    tslax += st.dTslax; usdc += st.dUsdc;
    const bal = (mint, amt) => ({ accountIndex: mint === TSLAX ? 1 : 2, mint, owner: OWNER, uiTokenAmount: { uiAmount: amt, uiAmountString: String(amt) } });
    const meta = { preTokenBalances: [], postTokenBalances: [], preBalances: [1e9], postBalances: [1e9], fee: 5000 };
    if (st.dTslax !== 0) { meta.preTokenBalances.push(bal(TSLAX, preT)); meta.postTokenBalances.push(bal(TSLAX, tslax)); }
    if (st.dUsdc !== 0) { meta.preTokenBalances.push(bal(USDC, preU)); meta.postTokenBalances.push(bal(USDC, usdc)); }
    txs.set(sig, { meta, transaction: { message: { accountKeys: [{ pubkey: OWNER }] } } });
    sigs.push({ signature: sig, slot, blockTime: st.ts, err: null });
  }
  return { sigs: sigs.reverse(), txs };
}

// fake RPC with a per-call behavior for getTransaction
function evilRpc({ sigs, txs, txBehavior }) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      if (method === "getSignaturesForAddress") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: sigs }));
        return;
      }
      calls++;
      const behave = typeof txBehavior === "function" ? txBehavior(calls) : txBehavior;
      if (behave === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: txs.get(params[0]) ?? null }));
      } else if (behave === "400") {
        res.writeHead(400); res.end();
      } else if (behave === "garbage") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>gateway error page</html>");
      } else if (behave === "hole") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32020, message: "Transaction not found" } }));
      } else if (behave === "429twice") {
        if (calls <= 4) { res.writeHead(429); res.end(); }
        else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: txs.get(params[0]) ?? null }));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const CONTRACT_ERR = /HTTP|fetch|JSON|scan/i; // an honest infrastructure error

test("world healthy: full report and the conservation invariant hold", async () => {
  const h = history();
  const fake = await evilRpc({ ...h, txBehavior: "ok" });
  try {
    const { trades } = await ingestWallet(OWNER, { rpcUrl: fake.url });
    assert.equal(trades.length, 3);
    const b = fifoBasis(trades);
    const q = (side) => trades.filter((t) => t.side === side).reduce((s, t) => s + t.qty, 0);
    assert.ok(Math.abs(q("buy") - q("sell") - b.openQty) < 1e-9, "units conservation");
    assert.ok(Number.isFinite(b.realizedUsd));
  } finally {
    fake.server.close();
  }
});

test("world hard-down: the scan fails loudly, never ships a hollow report", async () => {
  const h = history();
  const fake = await evilRpc({ ...h, txBehavior: "400" });
  try {
    await assert.rejects(ingestWallet(OWNER, { rpcUrl: fake.url }), CONTRACT_ERR);
  } finally {
    fake.server.close();
  }
});

test("world garbage: a gateway page instead of JSON fails the scan", async () => {
  const h = history();
  const fake = await evilRpc({ ...h, txBehavior: "garbage" });
  try {
    await assert.rejects(ingestWallet(OWNER, { rpcUrl: fake.url }), CONTRACT_ERR);
  } finally {
    fake.server.close();
  }
});

test("world all-holes: every tx missing resolves with a hole, not a crash or lies", async () => {
  const h = history();
  const fake = await evilRpc({ ...h, txBehavior: "hole" });
  try {
    const { trades, seen } = await ingestWallet(OWNER, { rpcUrl: fake.url });
    assert.equal(seen, 3);       // the walk still saw the history
    assert.equal(trades.length, 0); // and honestly reports no trades from holes
  } finally {
    fake.server.close();
  }
});

test("world throttling: transient 429s are retried through to a full report", async () => {
  const h = history();
  const fake = await evilRpc({ ...h, txBehavior: "429twice" });
  try {
    const { trades } = await ingestWallet(OWNER, { rpcUrl: fake.url });
    assert.equal(trades.length, 3);
  } finally {
    fake.server.close();
  }
});
