// Property tests: fifoBasis vs an independently written reference (cumulative
// cost-flow, no mutable lot state) over randomized trade sequences, plus
// internal consistency invariants. Seeded PRNG keeps failures reproducible.

import test from "node:test";
import assert from "node:assert/strict";
import { fifoBasis } from "../src/basis.mjs";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference FIFO via cumulative cost flows — deliberately different shape. */
function referenceFifo(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  // pool: array of [qtyRemaining, costRemaining] oldest-first, like the spec
  const pool = [];
  let realized = 0;
  let assumed = 0;
  let unknown = 0;
  let closedQty = 0;
  let closedCost = 0;

  for (const e of sorted) {
    if (e.side === "buy") { pool.push([e.qty, e.valueUsd]); continue; }
    if (e.side === "in") continue;
    if (e.side === "out") {
      let need = e.qty;
      while (need > 1e-12 && pool.length) {
        const [q, c] = pool[0];
        const take = Math.min(q, need);
        pool[0][0] = q - take;
        pool[0][1] = c - (take / q) * c;
        need -= take;
        if (pool[0][0] <= 1e-12) pool.shift();
      }
      continue;
    }
    // sell
    let need = e.qty;
    const perUnit = e.valueUsd / e.qty;
    while (need > 1e-12 && pool.length) {
      const [q, c] = pool[0];
      const take = Math.min(q, need);
      const pnl = take * perUnit - (take / q) * c;
      realized += pnl;
      assumed += pnl; // assumed variant includes all known-basis P&L
      closedQty += take;
      closedCost += (take / q) * c;
      pool[0][0] = q - take;
      pool[0][1] = c - (take / q) * c;
      need -= take;
      if (pool[0][0] <= 1e-12) pool.shift();
    }
    if (need > 1e-12) {
      unknown += need;
      if (Number.isFinite(e.marketPx) && e.marketPx > 0) {
        assumed += need * perUnit - need * e.marketPx;
      }
    }
  }

  // exact pass for out-cost removal (proportional across oldest lots)
  return { realized, assumed, unknown, closedQty, closedCost, openQty: pool.reduce((s, [q]) => s + q, 0), openCost: pool.reduce((s, [, c]) => s + c, 0) };
}

function randomEvents(rnd, n) {
  const events = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(rnd() * 3600);
    const roll = rnd();
    const qty = 0.01 + rnd() * 100;
    const px = 10 + rnd() * 490;
    const valueUsd = Math.round(qty * px * 100) / 100;
    const t = { ts, qty, valueUsd };
    if (roll < 0.45) events.push({ ...t, side: "buy" });
    else if (roll < 0.8) {
      const e = { ...t, side: "sell" };
      if (rnd() < 0.5) e.marketPx = Math.round(px * (0.8 + rnd() * 0.4) * 100) / 100;
      events.push(e);
    } else if (roll < 0.9) events.push({ ...t, side: "out", valueUsd: 0 });
    else events.push({ ...t, side: "in", valueUsd: 0 });
  }
  return events;
}

test("property: fifoBasis matches independent reference on 300 random sequences", () => {
  const rnd = mulberry32(20260912);
  for (let iter = 0; iter < 300; iter++) {
    const events = randomEvents(rnd, 3 + Math.floor(rnd() * 35));
    const got = fifoBasis(events);
    const exp = referenceFifo(events);

    const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!close(got.realizedUsd, exp.realized)) throw new Error(`iter ${iter}: realized ${got.realizedUsd} vs ${exp.realized} for ${JSON.stringify(events)}`);
    if (!close(got.openQty, exp.openQty)) throw new Error(`iter ${iter}: openQty ${got.openQty} vs ${exp.openQty}`);
    if (!close(got.openCostUsd, exp.openCost)) throw new Error(`iter ${iter}: openCost ${got.openCostUsd} vs ${exp.openCost}`);
    const gotUnknownQty = got.unknownBasis.reduce((s, u) => s + u.qty, 0);
    if (!close(gotUnknownQty, exp.unknown)) throw new Error(`iter ${iter}: unknown qty ${gotUnknownQty} vs ${exp.unknown}`);
    if (!close(got.realizedAssumed, exp.assumed)) throw new Error(`iter ${iter}: assumed ${got.realizedAssumed} vs ${exp.assumed}`);

    // internal consistency
    const pnlSum = got.closes.reduce((s, c) => s + c.pnlUsd, 0);
    if (!close(pnlSum, got.realizedUsd)) throw new Error(`iter ${iter}: closes pnl != realized`);
    const costSum = got.closes.reduce((s, c) => s + c.costUsd, 0);
    if (!close(costSum, got.realizedBuyUsd)) throw new Error(`iter ${iter}: closes cost != realizedBuyUsd`);
    const proceedsSum = got.closes.reduce((s, c) => s + c.proceedsUsd, 0);
    if (!close(proceedsSum - costSum, got.realizedUsd)) throw new Error(`iter ${iter}: proceeds-cost != realized`);
    for (const c of got.closes) {
      assert.ok(c.qty > 0 && c.proceedsUsd >= 0 && c.costUsd >= 0 && Number.isFinite(c.pnlUsd));
    }
    assert.ok(got.openQty >= 0 && got.openCostUsd >= 0);
  }
});
