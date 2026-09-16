// Regression: mainnet carries transactions of message version 1 (2026), and
// the cluster answers -32015 to getTransaction unless the request declares
// maxSupportedTransactionVersion >= 1. The scan used to declare 0, so any
// wallet whose window touched one versioned tx died with an honest error
// instead of a report. The stub reproduces the cluster: -32015 on a 0 or
// missing declaration, a normal jsonParsed buy on 1+.
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ingestWallet } from "../src/ingest.mjs";
import { primeTokenCache } from "../src/classify.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] });
process.env.STOCKBASIS_NO_MARKET ??= "1"; // no live market lookup in tests

const OWNER = "Wallet11111111111111111111111111111111111111";
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated, no network

const servers = [];
after(() => { for (const s of servers) s.close(); });

const stub = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
};

test("ingest: a version-1 transaction fetches instead of killing the scan", async () => {
  const T = 1_700_000_000;
  const tb = (i, mint, amount) => ({ accountIndex: i, mint, owner: OWNER, uiTokenAmount: { uiAmount: amount, uiAmountString: String(amount) } });
  const buyTx = {
    transaction: { message: { accountKeys: [{ pubkey: OWNER }] } },
    meta: {
      preTokenBalances: [tb(2, USDC, 1000)],
      postTokenBalances: [tb(1, TSLAX, 5), tb(2, USDC, 500)],
      preBalances: [1e9], postBalances: [1e9], fee: 0,
    },
  };
  const url = await stub((msg) => {
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") {
      const declared = msg.params[1]?.maxSupportedTransactionVersion;
      if (!(declared >= 1)) return { error: { code: -32015, message: "Transaction version (1) is not supported by the requesting client" } };
      return { result: buyTx };
    }
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  const { trades } = await ingestWallet(OWNER, { rpcUrl: url });
  assert.equal(trades.length, 1, "the buy must survive: the scan may not die on -32015");
});
