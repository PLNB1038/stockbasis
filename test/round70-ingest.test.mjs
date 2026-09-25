// Regression tests for polish round 70 (price window + ledger hygiene). Every
// test pins one proven vector:
//   price: a day beyond CoinGecko's 365-day public window is answered locally —
//          the API's 401 / error_code 10012 there is a permanent miss, not a
//          transient one, so the doomed network round-trip is skipped
//   ingest: an ancient unpriced cash leg discloses WHY it is unpriced
//           (unpricedReason:"ancient") while riding the existing disclosure
//           channels — unpriced legs land in transfers, partially valued
//           trades carry partialCash ("P&L understated"), movements stay
//           flag-free per the house rule that a movement has nothing to understate
//   ingest: an unpriced native SOL tail is recorded exactly once, at its real
//           delta — no ghost zero-delta duplicate (the ledger keeps the
//           record, never a corrupted copy of it)
//   report: an ancient partial-cash trade still surfaces in the understated counter

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0"; // no rpc in this file, kept for symmetry with the house style
process.env.STOCKBASIS_NO_MARKET ??= "1";

// offline determinism: CoinGecko never answers from the network. The stub
// mirrors the real ancient-day answer verified live on 2026-09-20
// (401, error_code 10012 "within the past 365 days").
const realFetch = globalThis.fetch;
let coingeckoCalls = 0;
globalThis.fetch = (u, o) => {
  if (String(u).includes("api.coingecko.com")) {
    coingeckoCalls++;
    return Promise.resolve({ ok: false, status: 401, json: async () => ({ status: "error", error_code: 10012 }) });
  }
  return realFetch(u, o);
};

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no metadata calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

const { pairTrades } = await import("../src/ingest.mjs");
const { solUsdOn, isAncientDay, primeSolDayCache } = await import("../src/price.mjs");
const { buildReport } = await import("../src/report.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");

primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(WSOL, { symbol: "WSOL", name: "", isStock: false, tags: [] }); // no live metadata lookup for deltas carrying WSOL

after(() => {
  globalThis.fetch = realFetch;
});

const now = Math.floor(Date.now() / 1000);
const ANCIENT_A = now - 400 * 86400; // beyond the public history window
const ANCIENT_B = now - 401 * 86400; // distinct cache day
const ANCIENT_C = now - 402 * 86400; // distinct cache day
const RECENT_A = now - 10 * 86400;
const RECENT_B = now - 11 * 86400;

const run = async (deltas, ctx) => {
  const trades = [];
  const transfers = [];
  await pairTrades(deltas, { slot: 1, signature: "r70", closedAta: 0, solDelta: 0, ...ctx }, trades, transfers);
  return { trades, transfers };
};

// ---- price: the 365-day public window is a permanent miss --------------------

test("price: a day beyond CoinGecko's 365-day window is answered without a network call", async () => {
  // the public history API rejects anything older with 401 / error_code 10012,
  // forever — a permanent miss must not burn the fetch path and must be
  // tellable apart from a transient outage
  assert.equal(typeof isAncientDay, "function", "price.mjs must expose the window predicate");
  assert.equal(isAncientDay(ANCIENT_A), true, "400 days old is beyond the public window");
  assert.equal(isAncientDay(RECENT_A), false, "10 days old is inside the window");

  const before = coingeckoCalls;
  assert.equal(await solUsdOn(ANCIENT_A), null, "an ancient day is unpriceable by design");
  assert.equal(coingeckoCalls, before, "the permanent miss must be answered locally, not by a doomed fetch");
  assert.equal(await solUsdOn(RECENT_A), null, "a recent day still goes through the live lookup (mocked 401 here)");
  assert.equal(coingeckoCalls, before + 1, "only the recent day may reach the (mocked) API");
});

// ---- ingest: ancient unpriced legs disclose themselves -----------------------

test("ingest: an ancient WSOL leg discloses itself as ancient on the partial-cash trade", async () => {
  primeSolDayCache(ANCIENT_A, null); // the day has no price source — permanently
  // buy 1 share for 180 USDC plus a 0.3 SOL leg the day's price cannot value:
  // the stable part must still book, the understated-P&L disclosure must fire,
  // and the trade must say the cause is the ancient day
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: 1 }, { mint: USDC, delta: -180 }, { mint: WSOL, delta: -0.3 }],
    { ts: ANCIENT_A },
  );
  const buy = trades.find((t) => t.side === "buy");
  assert.ok(buy, "the stable leg still books the buy");
  assert.ok(Math.abs(buy.valueUsd - 180) < 1e-9, `known money must survive (got ${buy?.valueUsd})`);
  assert.equal(buy.partialCash, true, "the existing understated-P&L disclosure must fire for ancient legs too");
  assert.equal(buy.unpricedReason, "ancient", "the trade must say WHY its cash is partial");
  assert.ok(
    transfers.some((t) => t.mint === WSOL && Math.abs(t.delta + 0.3) < 1e-9),
    `the unpriced WSOL leg must stay in the ledger (got ${JSON.stringify(transfers)})`,
  );
});

test("ingest: an ancient all-WSOL trade books a movement carrying the ancient reason", async () => {
  primeSolDayCache(ANCIENT_B, null);
  // nothing priced at all: the shares move with valueUsd 0 — a movement has no
  // proceeds to understate (no partialCash, house rule), but the cause must be
  // visible instead of reading as a data glitch
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: 1 }, { mint: WSOL, delta: -0.5 }],
    { ts: ANCIENT_B },
  );
  const mv = trades[0];
  assert.ok(mv, "the shares still move — never a disappearance");
  assert.equal(mv.side, "in");
  assert.equal(mv.valueUsd, 0, "nothing was priced: no value, never a guess");
  assert.equal(mv.partialCash, undefined, "a movement has no proceeds to understate");
  assert.equal(mv.unpricedReason, "ancient", "the movement must name the permanent cause");
  assert.ok(transfers.some((t) => t.mint === WSOL && Math.abs(t.delta + 0.5) < 1e-9), "the WSOL leg stays in the ledger");
  assert.ok(transfers.some((t) => t.mint === TSLAX && t.delta === 1), "the equity leg stays in the ledger");
});

test("ingest: an ancient legless SOL buy becomes a movement that names the cause", async () => {
  primeSolDayCache(ANCIENT_C, null);
  // paid 0.3 SOL for 2 shares, but the day sits outside the price window: the
  // whole-in-SOL trade degenerates to a movement — which must say why
  const { trades } = await run([{ mint: TSLAX, delta: 2 }], { ts: ANCIENT_C, solDelta: -0.3e9 });
  const mv = trades[0];
  assert.ok(mv, "the shares still book");
  assert.equal(mv.side, "in");
  assert.equal(mv.valueUsd, 0);
  assert.equal(mv.unpricedReason, "ancient", "the SOL leg was real trade cash that no price can value — say so");
});

// ---- ingest: the unpriced SOL tail is a record, not a ghost ------------------

test("ingest: an unpriced native SOL tail is recorded once, at its real delta", async () => {
  primeSolDayCache(RECENT_B, null);
  // sell 2 shares for 300 USDC plus a 0.4 SOL native tail the day's price
  // cannot value: the ledger keeps ONE record of the tail — real size, correct
  // sign — and never a ghost zero-delta duplicate of it
  const { trades, transfers } = await run(
    [{ mint: TSLAX, delta: -2 }, { mint: USDC, delta: 300 }],
    { ts: RECENT_B, solDelta: 0.4e9 },
  );
  const sell = trades.find((t) => t.side === "sell");
  assert.ok(sell, "the stable leg still books the sale");
  assert.ok(Math.abs(sell.valueUsd - 300) < 1e-9, `the unpriced tail must not block the priced leg (got ${sell?.valueUsd})`);
  assert.equal(sell.partialCash, true, "proceeds are understated — disclosed");
  const wsol = transfers.filter((t) => t.mint === WSOL);
  assert.equal(wsol.length, 1, `exactly one ledger record for the tail (got ${JSON.stringify(wsol)})`);
  assert.ok(Math.abs(wsol[0].delta - 0.4) < 1e-9, `the record must carry the real tail (got ${wsol[0]?.delta})`);
  assert.equal(transfers.filter((t) => t.delta === 0).length, 0, "a zero-delta ghost is a corrupted record, not a record");
});

// ---- report: the ancient path lands in the existing understated counter ------

test("report: an ancient partial-cash trade surfaces in the understated counter", async () => {
  // pins the routing: ancient legs ride the SAME partialCash channel the web
  // note renders ("proceeds and P&L are understated"), no separate counter needed
  const t = { side: "buy", mint: TSLAX, qty: 1, valueUsd: 180, ts: ANCIENT_A, slot: 1, signature: "r70rep", partialCash: true, unpricedReason: "ancient" };
  const report = await buildReport([t]);
  assert.equal(report.partialCash, 1, `the understated counter must count ancient legs (got ${report.partialCash})`);
});
