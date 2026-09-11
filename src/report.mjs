// Trades → per-stock FIFO summary (shared by CLI and server).

import { perStockSummary } from "./basis.mjs";
import { lookupToken } from "./classify.mjs";

/**
 * Build the full report payload from a flat list of trades.
 * @param {Array<import('./basis.mjs').Trade & {mint: string}>} trades
 * @returns {Promise<{rows: Array<object>, totalRealized: number, tokens: number}>}
 */
export async function buildReport(trades) {
  /** @type {Map<string, Array<import('./basis.mjs').Trade>>} */
  const byMint = new Map();
  for (const t of trades) {
    if (!byMint.has(t.mint)) byMint.set(t.mint, []);
    byMint.get(t.mint).push(t);
  }

  const metas = new Map();
  for (const mint of byMint.keys()) metas.set(mint, await lookupToken(mint));

  const rows = perStockSummary(byMint, (m) => metas.get(m));

  // flatten per-lot closings into one 1099-B style list
  const closes = [];
  for (const r of rows) {
    for (const c of r.closes ?? []) {
      closes.push({ symbol: r.symbol, mint: r.mint, ...c });
    }
  }
  closes.sort((a, b) => b.soldTs - a.soldTs);

  return {
    rows,
    closes,
    totalRealized: Math.round(rows.reduce((s, r) => s + r.realizedUsd, 0) * 100) / 100,
    unknownBasis: rows.reduce((s, r) => s + (r.unknownBasis ?? 0), 0),
    tokens: rows.length,
  };
}
