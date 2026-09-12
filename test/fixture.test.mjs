// Regression tests against REAL mainnet transactions (pruned to the fields the
// pipeline consumes). Fixtures live in test/fixtures/*.json; regenerate via
// the collector snippet in scripts/ if a wallet's history moves.
//
// Values asserted here were hand-checked against market prices at the time of
// each trade (NVDA ~$220, SPY ~$772, Anthropic PreStocks withdrawal 0.2014).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenDeltas, walletSolDelta, pairTrades } from "../src/ingest.mjs";
import { primeTokenCache } from "../src/classify.mjs";
import { primeSolDayCache } from "../src/price.mjs";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

function asTx(fx) {
  return { meta: fx.meta, transaction: { message: { accountKeys: fx.accountKeys } } };
}

// deterministic SOL pricing for the fixture days (real mainnet price at capture)
primeSolDayCache(1700000000, 102.39440297526501);
primeSolDayCache(1700100000, 102.39440297526501);

test("fixture usdc: NVDAx buy priced from SOL delta, fee excluded", async () => {
  const fx = load("usdc-5WsaLeLGPN.json");
  const tx = asTx(fx);
  const deltas = tokenDeltas(fx.meta, fx.owner);
  const eq = deltas.find((d) => d.mint === "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
  assert.ok(eq, "NVDAx movement missing from deltas");
  assert.ok(Math.abs(eq.delta - 1.24083708) < 1e-6);

  // fee payer's SOL delta must exclude the network fee
  const i = fx.accountKeys.findIndex((k) => k.pubkey === fx.owner);
  const raw = fx.meta.postBalances[i] - fx.meta.preBalances[i];
  assert.equal(walletSolDelta(tx, fx.owner), raw + fx.meta.fee);

  const trades = [], transfers = [];
  await pairTrades(deltas, { ts: fx.blockTime, signature: fx.signature, solDelta: walletSolDelta(tx, fx.owner) }, trades, transfers);
  const buy = trades.find((t) => t.side === "buy");
  assert.ok(buy, "buy not recorded");
  assert.ok(Math.abs(buy.qty - 1.240837) < 1e-4);
  assert.ok(buy.valueUsd > 200 && buy.valueUsd < 350, `implausible buy value ${buy.valueUsd}`);
});

test("fixture sol: SPYx sell paired against incoming SOL", async () => {
  const fx = load("sol-2fd5G7smWC.json");
  const tx = asTx(fx);
  const deltas = tokenDeltas(fx.meta, fx.owner);
  const eq = deltas.find((d) => d.mint === "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
  assert.ok(eq && eq.delta < 0, "SPYx sell movement missing");
  assert.ok(Math.abs(-eq.delta - 0.352644) < 1e-5);

  const trades = [], transfers = [];
  await pairTrades(deltas, { ts: fx.blockTime, signature: fx.signature, solDelta: walletSolDelta(tx, fx.owner) }, trades, transfers);
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "sell not recorded");
  assert.ok(Math.abs(sell.qty - 0.352644) < 1e-4);
  assert.ok(sell.valueUsd > 200 && sell.valueUsd < 350, `implausible sell value ${sell.valueUsd}`);
});

test("fixture out: withdrawal consumes lots and books no P&L", async () => {
  const fx = load("out-4MkgV2e9xY.json");
  const deltas = tokenDeltas(fx.meta, fx.owner);
  // two movements: an unrelated 31.4M token (ignored) and the ANTHROPIC withdrawal
  const eq = deltas.find((d) => d.mint === "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");
  assert.ok(eq && eq.delta < 0, "ANTHROPIC withdrawal missing");
  assert.ok(Math.abs(-eq.delta - 0.20140838) < 1e-6);

  primeTokenCache("39TJN39TRzLtdNfRsXkFn12M56cb8PKMshx8hQ8nuf7r", { symbol: "OTHER", name: "", isStock: false, tags: [] });
  const trades = [], transfers = [];
  await pairTrades(deltas, { ts: fx.blockTime, signature: fx.signature, solDelta: walletSolDelta(asTx(fx), fx.owner) }, trades, transfers);
  const out = trades.find((t) => t.side === "out");
  assert.ok(out, "withdrawal not recorded");
  assert.ok(Math.abs(out.qty - 0.20140838) < 1e-6);
  assert.equal(out.valueUsd, 0);
  assert.equal(trades.filter((t) => t.side === "buy" || t.side === "sell").length, 0);

  // the curated list classifies this mint deterministically (no network)
  const { lookupToken } = await import("../src/classify.mjs");
  const meta = await lookupToken("Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");
  assert.equal(meta?.isStock, true);
  assert.equal(meta?.symbol, "ANTHROPIC");
});
