import test from "node:test";
import assert from "node:assert/strict";
import { tokenDeltas, pairTrades } from "../src/ingest.mjs";
import { primeTokenCache } from "../src/classify.mjs";
import { primeSolDayCache } from "../src/price.mjs";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated → no network

const OWNER = "Wallet11111111111111111111111111111111111111";
const MINT = "StockMint111111111111111111111111111111111111";
const bal = (accountIndex, owner, uiAmount) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { uiAmount } });

test("tokenDeltas keeps two accounts of the same mint distinct", () => {
  const meta = {
    preTokenBalances: [bal(0, OWNER, 10), bal(1, "Other2222222222222222222222222222222222222", 100)],
    postTokenBalances: [bal(0, OWNER, 4), bal(1, "Other2222222222222222222222222222222222222", 97)],
  };
  const deltas = tokenDeltas(meta, OWNER);
  // account 0: 10 → 4 = −6; account 1 belongs to someone else — excluded
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, -6);
});

test("tokenDeltas catches accounts that vanished in the tx", () => {
  const meta = {
    preTokenBalances: [bal(0, OWNER, 5), bal(1, OWNER, 50)],
    postTokenBalances: [bal(1, OWNER, 50)], // account 0 closed
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, -5);
});

test("tokenDeltas ignores ownerless balances", () => {
  const meta = {
    preTokenBalances: [{ accountIndex: 0, mint: MINT, owner: undefined, uiTokenAmount: { uiAmount: 10 } }],
    postTokenBalances: [{ accountIndex: 0, mint: MINT, owner: undefined, uiTokenAmount: { uiAmount: 4 } }],
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 0);
});

test("tokenDeltas nets across accounts of one mint", () => {
  const meta = {
    preTokenBalances: [bal(0, OWNER, 10), bal(1, OWNER, 0)],
    postTokenBalances: [bal(0, OWNER, 0), bal(1, OWNER, 7)],
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 2);
  assert.equal(deltas.reduce((s, d) => s + d.delta, 0), -3);
});


test("rent reclaim after a withdrawal is not a micro-sale", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [], transfers = [];
  // gift-out 10 TSLAx + own-ATA rent reclaim (+0.00204 SOL) — был фейковый "sell за $0.30"
  await pairTrades([{ mint: TSLAX, delta: -10 }], { ts: 1, signature: "s1", solDelta: 2_040_000 }, trades, transfers);
  assert.equal(trades.filter((t) => t.side === "sell").length, 0);
  assert.equal(trades.find((t) => t.side === "out")?.qty, 10); // движение, не продажа
});

test("invisible SOL leg books a buy above the dust floor", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  primeSolDayCache(1700000000, 100);
  const trades = [];
  // buy 5 TSLAx: SOL delta −(500.002 SOL) — покупка + рента за новый ATA
  await pairTrades([{ mint: TSLAX, delta: 5 }], { ts: 1700000000, signature: "s2", solDelta: -500.002e9 }, trades, []);
  const buy = trades.find((t) => t.side === "buy");
  assert.equal(buy.qty, 5);
  assert.ok(buy.valueUsd > 40000 && buy.valueUsd < 60000, `value ${buy.valueUsd}`);
});

test("sub-floor SOL deltas never book sales", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [];
  await pairTrades([{ mint: TSLAX, delta: -1 }], { ts: 1700000001, signature: "s3", solDelta: 2_040_000 }, trades, []);
  assert.equal(trades.filter((t) => t.side === "sell").length, 0);
  assert.equal(trades.find((t) => t.side === "out")?.qty, 1);
});
