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

/** Reference FIFO — two-queue conservative model, written independently.
 * Models the statement policy: every booked line item (close cost, proceeds,
 * pnl, unknown proceeds, assumed pnl) is a cent atom rounded at creation. */
function referenceFifo(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const known = [];  // [qty, cost, ts] known-basis lots, oldest-first
  const unknown = []; // [qty, ts] custody deposits, oldest-first
  let realized = 0, assumed = 0, unknownSold = 0;
  const atom = (x) => Math.round(x * 100) / 100;

  // consume `need` units from whichever inventory is older; t == null
  // is a withdrawal: lots shrink at raw proportional cost, nothing is booked.
  // Sales allocate proceeds from the trade's own cash by largest remainder
  // (each row = rounded running total) and lots are cent atoms from birth,
  // mirroring the engine's reconciliation-with-the-chain contract
  function consume(need, t, px, budget) {
    while (need > 1e-12) {
      const k = known[0], u = unknown[0];
      const kTs = k ? k[2] : Infinity, uTs = u ? u[1] : Infinity;
      if (kTs === Infinity && uTs === Infinity) break;
      if (uTs <= kTs) {
        const take = Math.min(u[0], need);
        u[0] -= take; need -= take;
        if (t != null) {
          unknownSold += take;
          budget.taken += take;
          const proceeds = atom((t.valueUsd * budget.taken) / t.qty) - budget.alloc;
          budget.alloc += proceeds;
          if (Number.isFinite(px) && px > 0) assumed += atom(proceeds - take * px);
        }
        if (u[0] < 1e-12) unknown.shift();
      } else {
        const take = Math.min(k[0], need);
        if (t == null) {
          // withdrawals shrink lots at rounded cents (the engine keeps the
          // remainder a cent atom for the eventual closing row)
          const cost = k[0] - take < k[0] * 1e-9 ? k[1] : Math.min(atom((take / k[0]) * k[1]), k[1]);
          k[0] -= take; k[1] -= cost; need -= take;
        } else {
          budget.taken += take;
          const cost = k[0] - take < k[0] * 1e-9 ? k[1] : Math.min(atom((take / k[0]) * k[1]), k[1]);
          const proceeds = atom((t.valueUsd * budget.taken) / t.qty) - budget.alloc;
          budget.alloc += proceeds;
          const pnl = atom(proceeds - cost);
          realized += pnl; assumed += pnl;
          k[0] -= take; k[1] -= cost; need -= take;
        }
        if (k[0] < 1e-12) known.shift();
      }
    }
    return need;
  }

  for (const e of sorted) {
    if (e.side === "buy") { known.push([e.qty, atom(e.valueUsd), e.ts]); continue; }
    if (e.side === "in") { unknown.push([e.qty, e.ts]); continue; }
    if (e.side === "out") { consume(e.qty, null, NaN, { taken: 0, alloc: 0 }); continue; }
    // sell: consume inventory oldest-first; the residue beyond tracked
    // inventory is an unknown-basis disposal sharing the same cent budget
    const budget = { taken: 0, alloc: 0 };
    const residue = consume(e.qty, e, e.marketPx, budget);
    if (residue > 1e-12) {
      unknownSold += residue;
      const proceeds = atom((e.valueUsd * (budget.taken + residue)) / e.qty) - budget.alloc;
      if (Number.isFinite(e.marketPx) && e.marketPx > 0) assumed += atom(proceeds - residue * e.marketPx);
    }
  }

  return { realized, assumed, unknown: unknownSold, closedCost: 0, openQty: known.reduce((s, [q]) => s + q, 0), openCost: known.reduce((s, [, c]) => s + c, 0) };
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
