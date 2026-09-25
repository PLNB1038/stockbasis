// Regression tests for polish round 68. Every test pins one proven vector:
//   rpc: a concurrent caller's -32020 rotation cannot pin a hole on a mirror
//        that was never asked (the hole belongs to the url that answered)
//   ingest: native SOL leaving with a stable-paid buy is a side-flow, capped
//           out of the basis; the surplus stays in the ledger
//   ingest: a legitimate SOL-only buy still prices in full (no cap reference)
//   ingest: a sale's native SOL tail is proceeds and is not capped
//   ingest: a sub-floor native SOL tail beside stable legs lands in the ledger
//   ingest: postTokenBalances without a pre array void the read — no phantom
//   ingest: an empty pre array is a real account creation, not a voided read
//   ingest: a mint net of a sale plus a withdrawal carries nettedMixed
//   ingest: dust netting across accounts of one mint stays unflagged
//   report: nettedMixed trades are counted in the payload

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0"; // the race test below must not wait on pacing
process.env.STOCKBASIS_NO_MARKET ??= "1";

// offline determinism: no SOL price history ever reaches the network — a test
// that unexpectedly needs one must fail its assertions, not pass on live data
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) return Promise.resolve({ ok: false, json: async () => ({}) });
  return realFetch(u, o);
};

const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

// env must be in place before src/rpc.mjs reads its pacing knob at load time
const { rpc } = await import("../src/rpc.mjs");
const { pairTrades, tokenDeltas } = await import("../src/ingest.mjs");
const { buildReport } = await import("../src/report.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");
const { primeSolDayCache } = await import("../src/price.mjs");

primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });

const servers = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"), req, res);
      if (out === undefined) return; // handler wrote the response itself
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
after(() => {
  globalThis.fetch = realFetch;
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
});

const run = async (deltas, ctx) => {
  const trades = [];
  const transfers = [];
  await pairTrades(deltas, { slot: 1, signature: "r68", closedAta: 0, ...ctx }, trades, transfers);
  return { trades, transfers };
};

// ---- rpc: the -32020 hole belongs to the mirror that answered ---------------

test("rpc: a concurrent -32020 rotation cannot pin a hole on a mirror never asked", async () => {
  const askedA = [];
  const askedB = [];
  // mirror A lacks everything; mirror B serves everything. Both calls start
  // on A (the shared index), and the first caller's rotation moves the index
  // before the second caller records its hole — the old code credited
  // urls[endpointIdx] (mirror B!) and a second -32020 then read as a
  // confirmed all-mirrors hole, dropping the transaction silently
  const a = await stubServer((msg) => { askedA.push(msg.params[0]); return { error: { code: -32020, message: "Transaction not found" } }; });
  const b = await stubServer((msg) => { askedB.push(msg.params[0]); return { result: { slot: 1, sig: msg.params[0] } }; });

  const [r1, r2] = await Promise.all([
    rpc("getTransaction", ["sigOne", {}], { rpcUrl: `${a.url},${b.url}` }),
    rpc("getTransaction", ["sigTwo", {}], { rpcUrl: `${a.url},${b.url}` }),
  ]);
  assert.ok(r1 && r2, "both transactions must come back — a hole is per-endpoint, not per-request");
  assert.equal(r1.sig, "sigOne");
  assert.equal(r2.sig, "sigTwo");
  assert.ok(askedA.includes("sigTwo"), "mirror A must be asked about the second signature before it counts as a hole");
  assert.deepEqual(askedB, ["sigOne", "sigTwo"], "the live mirror must be asked about the second signature too");
});

// ---- ingest: the native SOL tail cannot buy basis it did not pay for --------

test("ingest: native SOL leaving with a stable-paid buy is a side-flow, not basis", async () => {
  const ts = 1_700_000_000;
  primeSolDayCache(ts, 200);
  // buy 1 share for 180 USDC while 0.5 SOL ($100) sweeps out to a third party:
  // the pre-cap code booked valueUsd=280 — basis the wallet never paid
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: 1 }, { mint: USDC, delta: -180 }],
    { ts, solDelta: -0.5e9 },
  );
  const buy = trades.find((t) => t.side === "buy");
  assert.ok(buy, "the buy still books");
  assert.ok(Math.abs(buy.valueUsd - 180) < 1e-9, `the tail is capped out of the basis (got ${buy.valueUsd})`);
  assert.ok(!buy.partialCash, "the stable legs fully price the trade");
  assert.ok(
    transfers.some((t) => t.mint === WSOL && Math.abs(t.delta + 0.5) < 1e-9),
    `the surplus must not vanish from the ledger (got ${JSON.stringify(transfers)})`,
  );
});

test("ingest: a legitimate SOL-only buy still prices in full", async () => {
  const ts = 1_710_000_000;
  primeSolDayCache(ts, 200);
  // legless buy paid entirely in SOL: the SOL flow IS the tx's price signal,
  // there is nothing independent to cap against — behavior must not change
  const { trades, transfers } = await run([{ mint: TSLAX, delta: 5 }], { ts, solDelta: -2e9 });
  const buy = trades.find((t) => t.side === "buy");
  assert.ok(buy, "an honest whole-in-SOL purchase must not be demoted");
  assert.ok(Math.abs(buy.valueUsd - 400) < 1e-9, `5 shares at 0.4 SOL each, SOL $200 (got ${buy.valueUsd})`);
  assert.equal(transfers.length, 0, "the paid tail is not a side-flow");
});

test("ingest: a sale's native SOL tail is proceeds and is not capped", async () => {
  const ts = 1_720_000_000;
  primeSolDayCache(ts, 100);
  // sell 5 shares for 50 USDC plus 0.5 SOL unwrapped from a temp account:
  // proceeds split across the stable leg and the native tail price in full
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: -5 }, { mint: USDC, delta: 50 }],
    { ts, solDelta: 0.5e9 },
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the sale must book");
  assert.ok(Math.abs(sell.valueUsd - 100) < 1e-9, `50 USDC + 0.5 SOL at $100 (got ${sell.valueUsd})`);
  assert.equal(transfers.length, 0, "fully accepted proceeds are not re-recorded as movements");
});

test("ingest: a sub-floor native SOL tail beside stable legs lands in the ledger", async () => {
  const ts = 1_730_000_000; // unpriced day: the tail is below the leg floor and needs no price
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: -1 }, { mint: USDC, delta: 200 }],
    { ts, solDelta: 0.005e9 },
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the stable leg still prices the sale");
  assert.ok(Math.abs(sell.valueUsd - 200) < 1e-9);
  assert.ok(!sell.partialCash, "the dust tail is a movement, not a partial valuation");
  assert.ok(
    transfers.some((t) => t.mint === WSOL && Math.abs(t.delta - 0.005) < 1e-9),
    `the sub-floor tail must not vanish silently (got ${JSON.stringify(transfers)})`,
  );
});

// ---- ingest: a hostile mirror that never read the prior balances -------------

test("ingest: postTokenBalances without a pre array void the read, never book a phantom", async () => {
  const bal = (accountIndex, amount) => ({ accountIndex, mint: TSLAX, owner: OWNER, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  // a mirror that never read the prior state claims we hold 10: diffing
  // against an invented empty past books a phantom +10 deposit ("in") that
  // mints unknown basis out of nothing
  for (const pre of [null, undefined]) {
    const meta = { preTokenBalances: pre, postTokenBalances: [bal(0, 10)] };
    assert.equal(tokenDeltas(meta, OWNER).length, 0, `pre=${pre}: an unreadable past voids the whole reading`);
    const trades = [], transfers = [];
    await pairTrades(tokenDeltas(meta, OWNER), { ts: 1, signature: "void" }, trades, transfers);
    assert.equal(trades.length, 0, "no phantom trade from half a balance reading");
    assert.equal(transfers.length, 0);
  }
  // the vanish shape (a 10→0 sale whose pre side is missing) must not book a
  // fake sale either: the honest answer is "this tx's balance change is unknown"
  const sale = { preTokenBalances: null, postTokenBalances: [bal(0, 0)] };
  assert.equal(tokenDeltas(sale, OWNER).length, 0);
});

test("ingest: an empty pre array is a real account creation, not a voided read", () => {
  const bal = (accountIndex, amount) => ({ accountIndex, mint: TSLAX, owner: OWNER, uiTokenAmount: { uiAmountString: String(amount), uiAmount: amount } });
  const created = tokenDeltas({ preTokenBalances: [], postTokenBalances: [bal(0, 10)] }, OWNER);
  assert.equal(created.length, 1, "an account created in the tx legitimately has no prior balances");
  assert.equal(created[0].delta, 10);
});

// ---- ingest: netting several movements of one mint discloses itself ----------

test("ingest: a mint net of a sale plus a custody withdrawal carries nettedMixed", async () => {
  // sold 5 (proceeds are for 5) plus 3 swept to custody in the same tx: the
  // net −8 books a sell of 8 — the proceeds are smeared and must be flagged
  const { trades } = await run(
    [{ mint: TSLAX, delta: -5 }, { mint: TSLAX, delta: -3 }, { mint: USDC, delta: 250 }],
    { ts: 1, solDelta: 0 },
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the netted sale books");
  assert.equal(sell.qty, 8);
  assert.equal(sell.nettedMixed, true, "the smear must be disclosed on the trade");
});

test("ingest: dust netting across accounts of one mint stays unflagged", async () => {
  // the benign case netting exists for: a nano dust remainder of the same mint
  const { trades } = await run(
    [{ mint: TSLAX, delta: -5 }, { mint: TSLAX, delta: -2e-9 }, { mint: USDC, delta: 250 }],
    { ts: 1, solDelta: 0 },
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell);
  assert.equal(sell.nettedMixed, undefined, "a dust-split mint is not a mixed netting");
});

// ---- report: the counter rides the payload like partialCash/aggregated -------

test("report: nettedMixed trades are counted in the payload", async () => {
  const t = (sig, mixed) => ({ side: "sell", mint: TSLAX, qty: 8, valueUsd: 250, ts: 1, slot: 1, signature: sig, ...(mixed ? { nettedMixed: true } : {}) });
  const report = await buildReport([t("n1", true), t("n2", true), t("n3", false)]);
  assert.equal(report.nettedMixed, 2, `the counter counts netted trades (got ${report.nettedMixed})`);
});
