import test from "node:test";
import assert from "node:assert/strict";
import { tokenDeltas } from "../src/ingest.mjs";

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

test("tokenDeltas nets across accounts of one mint", () => {
  const meta = {
    preTokenBalances: [bal(0, OWNER, 10), bal(1, OWNER, 0)],
    postTokenBalances: [bal(0, OWNER, 0), bal(1, OWNER, 7)],
  };
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 2);
  assert.equal(deltas.reduce((s, d) => s + d.delta, 0), -3);
});
