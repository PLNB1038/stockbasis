// Regression tests for polish round 73 (external APIs in degradation). Every
// test pins one proven vector:
//   rpc: an empty signature page from one mirror is cross-checked before it
//        may end the walk — one 429 must not truncate history silently
//   rpc: a 200-OK whose result is not a list is not "history ends here"
//   price: a zero SOL day price is rejected like a missing one
//   classify: a broken curated file announces itself instead of reading as
//        an empty universe
//   rpc: -32602 rotates through unasked mirrors — one legacy gateway must not
//        veto params a modern sibling serves
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { ingestWallet } from "../src/ingest.mjs";
import { solUsdOn } from "../src/price.mjs";
import { primeTokenCache } from "../src/classify.mjs";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });

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
      if (out === undefined) return; // handler answered by itself (429 etc.)
      if (out.raw !== undefined) { res.writeHead(out.status ?? 200, { "Content-Type": "application/json" }); res.end(out.raw); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};

const T = 1_700_000_000;
const sig = (s, i) => ({ signature: s, slot: i, blockTime: T, err: null });
const buyTx = (who) => ({
  transaction: { message: { accountKeys: [{ pubkey: who ?? OWNER }] } },
  meta: {
    preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: OWNER, uiTokenAmount: { uiAmount: 1000, uiAmountString: "1000" } }],
    postTokenBalances: [
      { accountIndex: 1, mint: TSLAX, owner: OWNER, uiTokenAmount: { uiAmount: 5, uiAmountString: "5" } },
      { accountIndex: 2, mint: USDC, owner: OWNER, uiTokenAmount: { uiAmount: 500, uiAmountString: "500" } },
    ],
    preBalances: [1e9], postBalances: [1e9], fee: 0, blockTime: T,
  },
});
const txFor = { sig1: buyTx(), sig2: buyTx(), sig3: buyTx() };

test("rpc: an empty page from a shallow mirror cannot end the walk alone", async () => {
  // page2 of the history: first ask gets a 429 (rotation to the sibling),
  // the sibling answers [] (the lie), the cross-check re-asks and recovers
  let page2Calls = 0;
  const handler = (msg) => {
    if (msg.method === "getSignaturesForAddress") {
      const before = msg.params[1]?.before;
      if (!before) return { result: [sig("sig1", 1), sig("sig2", 2)] };
      if (before === "sig2") {
        page2Calls++;
        if (page2Calls === 1) return undefined; // 429 handled below via raw
        if (page2Calls === 2) return { result: [] }; // the shallow mirror's lie
        return { result: [sig("sig3", 3)] };
      }
      return { result: [] }; // past the end: both mirrors agree
    }
    if (msg.method === "getTransaction") return { result: txFor[msg.params[0]] ?? null };
    return { result: [] };
  };
  const mk = async (isDeep) => {
    const s = await stubServer((msg, req) => {
      const out = handler(msg, req);
      if (out === undefined) {
        // only the first mirror throttles page2 once; the sibling just lies
        if (isDeep && msg.method === "getSignaturesForAddress" && msg.params[1]?.before === "sig2" && page2Calls === 1) {
          return { raw: "throttled", status: 429 };
        }
        return { result: [] };
      }
      return out;
    });
    return s.url;
  };
  const [deep, shallow] = await Promise.all([mk(true), mk(false)]);
  const { trades } = await ingestWallet(OWNER, { rpcUrl: `${deep},${shallow}`, maxScanTx: 50, targetStockTrades: 10 });
  assert.equal(trades.length, 3, "the recovered page must keep all three buys — a 429 must not silently truncate history");
});

test("rpc: a 200-OK whose result is not a list is not the end of history", async () => {
  // the garbage flag is shared: whichever mirror serves the very first page
  // answers a gateway object, and the cross-check lands on the other one
  let firstSigCall = true;
  const mk = () => stubServer((msg) => {
    if (msg.method === "getSignaturesForAddress") {
      const before = msg.params[1]?.before;
      if (!before && firstSigCall) {
        firstSigCall = false;
        return { raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { gateway: "true" } }) };
      }
      if (!before) return { result: [sig("sig1", 1), sig("sig2", 2)] };
      return { result: [] };
    }
    if (msg.method === "getTransaction") return { result: txFor[msg.params[0]] ?? null };
    return { result: [] };
  });
  const [a, b] = await Promise.all([mk(), mk()]);
  const { trades } = await ingestWallet(OWNER, { rpcUrl: `${a.url},${b.url}`, maxScanTx: 50, targetStockTrades: 10 });
  assert.ok(trades.length >= 1, "the cross-check must recover the history a broken envelope hid");
});

test("price: a zero SOL day price is rejected like a missing one", async () => {
  const stub = await stubServer(() => ({ raw: JSON.stringify({ market_data: { current_price: { usd: 0 } } }) }));
  process.env.COINGECKO_URL = stub.url;
  const ts = Math.floor(Date.now() / 1000) - 3600; // recent, not ancient
  const usd = await solUsdOn(ts);
  assert.equal(usd, null, "usd=0 must degrade to null (unpriced movement), never fabricate a $0 SOL price");
});

test("classify: a broken curated file announces itself", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sb-r73-"));
  for (const d of ["src", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await writeFile(path.join(dir, "data", "stocks.json"), "{ this is not json", "utf8");
  const child = spawn(process.execPath, ["-e", "import(require('url').pathToFileURL('./src/classify.mjs').href).then(()=>process.exit(0),()=>process.exit(1))"], {
    cwd: dir,
    env: { ...process.env, JUP_SEARCH_URL: "http://127.0.0.1:1/search" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, "the module itself loads fine — only the file is broken");
  assert.match(stderr, /curated universe load failed/, "a silent empty universe is indistinguishable from a healthy one with no stocks");
});

test("rpc: -32602 rotates through unasked mirrors before failing", async () => {
  const tx = buyTx();
  // the FIRST getTransaction whichever mirror receives answers like a legacy
  // gateway that never learned the params — deterministic regardless of the
  // shared rotation index; the sibling (unasked) serves the same tx fine
  // whoever serves the first getTransaction IS the legacy gateway forever —
  // a per-mirror trait survives fetchTx's own retry, so only a real rotation
  // to the unasked sibling can save the scan
  let legacyUrl = null;
  const mk = () => stubServer((msg, req) => {
    const myUrl = `http://${req.headers.host}`;
    if (msg.method === "getSignaturesForAddress") return { result: msg.params[1]?.before ? [] : [sig("sig1", 1)] };
    if (msg.method === "getTransaction") {
      if (legacyUrl === null) legacyUrl = myUrl;
      if (myUrl === legacyUrl) return { error: { code: -32602, message: "Invalid params: unknown field maxSupportedTransactionVersion" } };
      return { result: tx };
    }
    return { result: [] };
  });
  const [a, b] = await Promise.all([mk(), mk()]);
  const { trades } = await ingestWallet(OWNER, { rpcUrl: `${a.url},${b.url}`, maxScanTx: 50, targetStockTrades: 10 });
  assert.equal(trades.length, 1, "one legacy rejection must rotate to the unasked mirror, not veto the scan");
});
