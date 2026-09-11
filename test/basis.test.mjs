import test from "node:test";
import assert from "node:assert/strict";
import { fifoBasis } from "../src/basis.mjs";

const t = (side, qty, valueUsd, ts) => ({ side, qty, valueUsd, ts });

test("buy then sell realizes P&L FIFO", () => {
  const r = fifoBasis([
    t("buy", 10, 1000, 1), // lot 1: 10 @ 100
    t("buy", 10, 1200, 2), // lot 2: 10 @ 120
    t("sell", 15, 1800, 3), // consumes 10@100 + 5@120 — two close rows, one per lot
  ]);
  assert.equal(r.openQty, 5);
  assert.equal(r.openCostUsd, 600);
  assert.equal(r.realizedBuyUsd, 1000 + 600);
  assert.equal(r.realizedUsd, 1800 - 1600);
  assert.equal(r.closes.length, 2);
  assert.equal(r.closes[0].acquiredTs, 1);
  assert.equal(r.closes[1].acquiredTs, 2);
});

test("partial lot consumption", () => {
  const r = fifoBasis([
    t("buy", 5, 500, 1),
    t("sell", 2, 300, 2),
  ]);
  assert.equal(r.openQty, 3);
  assert.equal(r.openCostUsd, 300);
  assert.equal(r.closes[0].costUsd, 200);
  assert.equal(r.closes[0].pnlUsd, 100);
});

test("unsorted input is sorted by time", () => {
  const a = fifoBasis([t("buy", 1, 100, 5), t("buy", 1, 200, 1), t("sell", 1, 150, 9)]);
  // FIFO must consume the ts=1 lot (cost 200), not ts=5 (cost 100)
  assert.equal(a.closes[0].costUsd, 200);
  assert.equal(a.realizedUsd, -50);
});

test("selling shares with no known lots is excluded from P&L, not booked as profit", () => {
  const r = fifoBasis([t("sell", 5, 500, 1), t("buy", 3, 300, 2)]);
  assert.equal(r.realizedUsd, 0); // the 5-share sell had unknown basis — not profit
  assert.equal(r.unknownBasis.length, 1);
  assert.equal(r.unknownBasis[0].qty, 5);
  assert.equal(r.closes.length, 0);
  assert.equal(r.openQty, 3); // the later buy remains an open lot
});

test("sell spanning known and unknown basis splits cleanly", () => {
  const r = fifoBasis([t("buy", 3, 300, 1), t("sell", 5, 500, 2)]);
  // 3 known shares: proceeds 300, cost 300 → pnl 0; 2 unknown shares excluded
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].qty, 3);
  assert.equal(r.closes[0].pnlUsd, 0);
  assert.equal(r.realizedUsd, 0);
  assert.equal(r.unknownBasis.length, 1);
  assert.equal(r.unknownBasis[0].proceedsUsd, 200);
});

test("no trades -> zero everything", () => {
  const r = fifoBasis([]);
  assert.equal(r.realizedUsd, 0);
  assert.equal(r.openQty, 0);
  assert.equal(r.closes.length, 0);
});
