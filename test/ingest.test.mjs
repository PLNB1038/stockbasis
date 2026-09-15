import test from "node:test";
import assert from "node:assert/strict";
import { tokenDeltas, pairTrades, applySanityGate, WSOL } from "../src/ingest.mjs";
import { fifoBasis } from "../src/basis.mjs";
import { primeTokenCache } from "../src/classify.mjs";
import { primeSolDayCache } from "../src/price.mjs";

// offline determinism: seed cash-leg tokens so no test ever touches Jupiter
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
primeTokenCache(USDC_MINT, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL_MINT, { symbol: "WSOL", name: "", isStock: false, tags: [] });
process.env.STOCKBASIS_NO_MARKET ??= "1"; // no live market lookup in tests

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated → no network
const OTHERX = "StockMint2222222222222222222222222222222222";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
  // gift-out 10 TSLAx + own-ATA rent reclaim (+0.00204 SOL) — must not book a dust "sell"
  await pairTrades([{ mint: TSLAX, delta: -10 }], { ts: 1, signature: "s1", solDelta: 2_040_000 }, trades, transfers);
  assert.equal(trades.filter((t) => t.side === "sell").length, 0);
  assert.equal(trades.find((t) => t.side === "out")?.qty, 10); // a movement, not a sale
});

test("invisible SOL leg books a buy above the dust floor", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  primeSolDayCache(1700000000, 100);
  const trades = [];
  // buy 5 TSLAx: SOL delta −(500.002 SOL) — purchase plus rent for a new ATA
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

test("same-sign cash legs net before pricing, not after", async () => {
  // buy 1 TSLAx paying 250 USDC while 100 USDC comes back in the same tx
  // (aggregator cashback): the netted cash leg is -150, so valueUsd must be
  // 150 — the cash actually spent, never 250 (gross) or 350 (both legs summed)
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [];
  await pairTrades(
    [{ mint: TSLAX, delta: 1 }, { mint: USDC, delta: -250 }, { mint: USDC, delta: 100 }],
    { ts: 1700000002, signature: "s6", solDelta: 0 },
    trades, [],
  );
  const buy = trades.find((t) => t.side === "buy");
  assert.ok(buy, "buy not recorded");
  assert.ok(Math.abs(buy.valueUsd - 150) < 1e-6, `cash netting wrong: ${buy.valueUsd}`);
});

test("receiving stock and cash together is a deposit, never an invented trade", async () => {
  // a wallet receives 1 TSLAx AND 50 USDC in one tx (referral bonus, rebate):
  // pairing same-sign legs would book a fake 'sell' with wrong proceeds —
  // the honest record is a basis-less deposit
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  const trades = [], transfers = [];
  await pairTrades(
    [{ mint: TSLAX, delta: 1 }, { mint: USDC, delta: 50 }],
    { ts: 1700000003, signature: "s7", solDelta: 0 },
    trades, transfers,
  );
  assert.equal(trades.filter((t) => t.side === "buy" || t.side === "sell").length, 0);
  assert.equal(trades.find((t) => t.side === "in")?.qty, 1);
  assert.equal(trades[0].valueUsd, 0);
});

test("multi-leg bundle books movements, not vanishing shares", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  primeTokenCache(OTHERX, { symbol: "OTHERx", name: "", isStock: true, tags: [] });
  const trades = [], transfers = [];
  // two stocks out against stablecoin in — no greedy split, but inventory must move
  await pairTrades(
    [{ mint: TSLAX, delta: -3 }, { mint: OTHERX, delta: -2 }, { mint: USDC, delta: 500 }],
    { ts: 1, signature: "s4", solDelta: 0 },
    trades, transfers,
  );
  assert.equal(trades.filter((t) => t.side === "sell" || t.side === "buy").length, 0); // no invented P&L
  assert.equal(trades.filter((t) => t.side === "out").length, 2); // both legs leave the inventory
  // round8: the bundle's cash side is ledgered too — the dollars did move
  assert.equal(transfers.length, 3);
  assert.ok(transfers.some((t) => t.mint === USDC && t.delta === 500));
});

test("multi-leg out consumes lots — no phantom open position", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  primeTokenCache(OTHERX, { symbol: "OTHERx", name: "", isStock: true, tags: [] });
  const trades = [], transfers = [];
  await pairTrades([{ mint: TSLAX, delta: 3 }, { mint: USDC, delta: -300 }], { ts: 100, signature: "b1", solDelta: 0 }, trades, transfers);
  await pairTrades([{ mint: TSLAX, delta: -3 }, { mint: OTHERX, delta: -2 }, { mint: USDC, delta: 310 }], { ts: 200, signature: "b2", solDelta: 0 }, trades, transfers);
  const b = fifoBasis(trades);
  assert.equal(b.openQty, 0);      // the shares left the wallet — nothing may stay open
  assert.equal(b.realizedUsd, 0);  // and no P&L was invented for the bundle
  assert.equal(b.closes.length, 0);
  // round8: 2 equity movements plus the bundle's USDC cash side
  assert.equal(transfers.length, 3);
  assert.ok(transfers.some((t) => t.mint === USDC && t.delta === 310));
});

test("unpriced WSOL leg books a movement, not a phantom lot", async () => {
  primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
  primeSolDayCache(1700000002, null); // no price source for that day
  const trades = [], transfers = [];
  await pairTrades([{ mint: TSLAX, delta: -2 }, { mint: WSOL, delta: 100 }], { ts: 1700000002, signature: "s5", solDelta: 0 }, trades, transfers);
  assert.equal(trades.filter((t) => t.side === "sell").length, 0);
  assert.equal(trades.find((t) => t.side === "out")?.qty, 2); // shares left — consume the lots
  // round8: the unpriced WSOL leg stays visible in the ledger
  assert.equal(transfers.length, 2);
  assert.ok(transfers.some((t) => t.mint === WSOL && t.delta === 100));
});

test("sanity gate: old out-of-band trade becomes a movement, never a disappearance", () => {
  const now = 1_758_000_000;
  const oldTs = now - 30 * 86400;
  const prices = new Map([[TSLAX, 100]]);
  const trades = [
    { side: "sell", mint: TSLAX, qty: 5, valueUsd: 5000, ts: oldTs }, // implied $1000 vs $100 — way off, old
    { side: "buy", mint: TSLAX, qty: 2, valueUsd: 10, ts: oldTs },    // implied $5 vs $100 — way off, old
  ];
  const { corrected, ambiguous } = applySanityGate(trades, prices, now);
  assert.equal(corrected, 0);
  assert.equal(ambiguous, 2);
  assert.equal(trades.length, 2);       // nothing spliced away
  assert.equal(trades[0].side, "out");  // the sale still removes the shares from inventory
  assert.equal(trades[0].valueUsd, 0);
  assert.equal(trades[1].side, "in");   // the buy becomes unknown-basis inventory
  assert.equal(trades[1].valueUsd, 0);
});

test("sanity gate: recent out-of-band trade is repriced at market", () => {
  const now = 1_758_000_000;
  const recentTs = now - 86400;
  const prices = new Map([[TSLAX, 100]]);
  const trades = [{ side: "sell", mint: TSLAX, qty: 5, valueUsd: 5000, ts: recentTs }];
  const { corrected, ambiguous } = applySanityGate(trades, prices, now);
  assert.equal(corrected, 1);
  assert.equal(ambiguous, 0);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].valueUsd, 500);
  assert.equal(trades[0].priceCorrected, true);
});

test("sanity gate: in-band trades pass through completely untouched", () => {
  // the implied price must be value/qty — a fair trade is never repriced,
  // never flagged, never converted to a movement
  const now = 1_758_000_000;
  const prices = new Map([[TSLAX, 100]]);
  const trades = [
    { side: "buy", mint: TSLAX, qty: 2, valueUsd: 200, ts: now - 86400 },
    { side: "sell", mint: TSLAX, qty: 1, valueUsd: 100, ts: now - 3600 },
  ];
  const { corrected, ambiguous } = applySanityGate(trades, prices, now);
  assert.equal(corrected, 0);
  assert.equal(ambiguous, 0);
  assert.equal(trades[0].valueUsd, 200); // exact values preserved
  assert.equal(trades[1].valueUsd, 100);
  assert.ok(!trades[0].priceCorrected && !trades[1].priceCorrected);
  assert.equal(trades[0].side, "buy"); // sides preserved
  assert.equal(trades[1].side, "sell");
});
