// Adversarial chain-data generator: hostile but chain-legal transaction shapes
// (multi-token bundles, mixed owners, dust, whale sizes, fee-sized SOL deltas,
// stablecoin-only noise) fed through pairTrades. The invariant: per stock
// mint, the SIGNED trade quantities fully explain the on-chain net delta —
// movements may be unpriced, but they never vanish.

import test from "node:test";
import assert from "node:assert/strict";
import { pairTrades, tokenDeltas, WSOL } from "../src/ingest.mjs";
import { fifoBasis } from "../src/basis.mjs";
import { primeTokenCache } from "../src/classify.mjs";
import { primeSolDayCache } from "../src/price.mjs";

// offline determinism: seed cash-leg tokens so no test ever touches Jupiter
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
primeTokenCache(USDC_MINT, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL_MINT, { symbol: "WSOL", name: "", isStock: false, tags: [] });
process.env.STOCKBASIS_NO_MARKET ??= "1"; // no live market lookup in tests

const STOCK_A = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated
const STOCK_B = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"; // curated
const JUNK = "Meme111111111111111111111111111111111111111";
primeTokenCache(JUNK, { symbol: "JUNK", name: "", isStock: false, tags: [] });

const OWNER = "Aaaa1111111111111111111111111111111111111111";
const OTHER = "Booo2222222222222222222222222222222222222222";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const logUniform = (rnd, lo, hi) => Math.exp(Math.log(lo) + rnd() * (Math.log(hi) - Math.log(lo)));

test("adversarial histories: trades fully explain every stock-mint net delta", async () => {
  const rnd = mulberry32(20260914);
  let checks = 0;
  for (let iter = 0; iter < 2000; iter++) {
    const day = 1_700_000_000 + Math.floor(rnd() * 300) * 86400;
    if (rnd() < 0.5) primeSolDayCache(day, logUniform(rnd, 10, 500));
    else primeSolDayCache(day, null); // unpriced day: legs must become movements, not vanish

    const mints = [STOCK_A, STOCK_B, USDC_MINT, WSOL_MINT, JUNK];
    const pickMint = () => (rnd() < 0.65 ? (rnd() < 0.5 ? STOCK_A : STOCK_B) : mints[2 + Math.floor(rnd() * 3)]);
    const balances = new Map(mints.map((m) => [m, 0]));
    const deltas = [];
    const nMoves = 1 + Math.floor(rnd() * 5);
    for (let i = 0; i < nMoves; i++) {
      const mint = i === 0 ? (rnd() < 0.5 ? STOCK_A : STOCK_B) : pickMint();
      let delta = (rnd() < 0.5 ? 1 : -1) * logUniform(rnd, 1e-4, 5000);
      delta = Math.round(delta * 1e6) / 1e6;
      if (balances.get(mint) + delta < 0) delta = -balances.get(mint); // keep chain-legal
      if (delta === 0) continue;
      balances.set(mint, Math.round((balances.get(mint) + delta) * 1e6) / 1e6);
      deltas.push({ mint, delta });
    }
    if (!deltas.length) continue;

    const ctx = {
      ts: day + Math.floor(rnd() * 86399),
      slot: Math.floor(rnd() * 1e6),
      signature: `adv${iter}`,
      // fee-sized and whale-sized SOL deltas exercise the dust floor both ways
      solDelta: rnd() < 0.4 ? Math.round((rnd() < 0.5 ? -1 : 1) * logUniform(rnd, 1e6, 1e10)) : 0,
    };
    const trades = [], transfers = [];
    await pairTrades(deltas, ctx, trades, transfers);

    for (const t of trades) {
      assert.ok(Number.isFinite(t.qty) && t.qty > 0, `iter ${iter}: bad qty ${t.qty}`);
      assert.ok(Number.isFinite(t.valueUsd) && t.valueUsd >= 0, `iter ${iter}: bad value ${t.valueUsd}`);
    }
    for (const mint of [STOCK_A, STOCK_B]) {
      const net = deltas.filter((d) => d.mint === mint).reduce((s, d) => s + d.delta, 0);
      if (Math.abs(net) < 1e-9) continue;
      let signed = 0;
      for (const t of trades) {
        if (t.mint !== mint) continue;
        signed += t.side === "buy" || t.side === "in" ? t.qty : -t.qty;
      }
      const ok = Math.abs(signed - net) < 1e-6 * Math.max(1, Math.abs(net));
      assert.ok(ok, `iter ${iter}: ${mint.slice(0, 4)} trades explain ${signed} vs on-chain ${net} (ctx ${JSON.stringify(ctx)}, deltas ${JSON.stringify(deltas)})`);
      checks++;
    }
  }
  assert.ok(checks > 1500, "generator coverage collapsed");
});

test("owner mismatches never book someone else's shares", async () => {
  // balances belonging to another owner move inside OUR transaction: the
  // scanner must ignore them completely
  const day = 1_750_000_000;
  primeSolDayCache(day, 100);
  const meta = {
    preTokenBalances: [
      { accountIndex: 1, mint: STOCK_A, owner: OTHER, uiTokenAmount: { uiAmount: 10, uiAmountString: "10" } },
      { accountIndex: 2, mint: STOCK_A, owner: OWNER, uiTokenAmount: { uiAmount: 5, uiAmountString: "5" } },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: STOCK_A, owner: OTHER, uiTokenAmount: { uiAmount: 0, uiAmountString: "0" } },
      { accountIndex: 2, mint: STOCK_A, owner: OWNER, uiTokenAmount: { uiAmount: 5, uiAmountString: "5" } },
    ],
  };
  const { tokenDeltas } = await import("../src/ingest.mjs");
  const deltas = tokenDeltas(meta, OWNER);
  assert.equal(deltas.length, 0); // only the unchanged own balance — nothing to book
});

test("fifty thousand trades keep the books finite and exact", () => {
  const trades = [{ side: "buy", mint: STOCK_A, qty: 25000, valueUsd: 2_500_000, ts: 1, slot: 1 }];
  for (let i = 0; i < 49998; i++) {
    trades.push({ side: "sell", mint: STOCK_A, qty: 0.5, valueUsd: 55, ts: 2 + i, slot: i });
  }
  trades.push({ side: "sell", mint: STOCK_A, qty: 1, valueUsd: 110, ts: 100000, slot: 1 }); // 24999.5+... keep sane
  const b = fifoBasis(trades);
  assert.ok(Number.isFinite(b.realizedUsd) && Number.isFinite(b.openQty));
  assert.ok(b.openQty >= 0);
  assert.ok(Math.abs(b.closes.reduce((s, c) => s + c.pnlUsd, 0) - b.realizedUsd) < 1e-6 * Math.max(1, Math.abs(b.realizedUsd)));
});
