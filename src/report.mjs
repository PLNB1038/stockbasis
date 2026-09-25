// Trades → per-stock FIFO summary (shared by CLI and server).

import { perStockSummary } from "./basis.mjs";
import { lookupToken } from "./classify.mjs";

/**
 * Build the full report payload from a flat list of trades.
 * @param {Array<import('./basis.mjs').Trade & {mint: string}>} trades
 * @param {{signal?: AbortSignal}} [opts] an aborted scan stops paying for
 *   token-metadata lookups too, exactly like the ingest path does
 * @returns {Promise<{rows: Array<object>, totalRealized: number, tokens: number, unknownBasis: number, priceCorrections: number}>}
 */
export async function buildReport(trades, { signal } = {}) {
  /** @type {Map<string, Array<import('./basis.mjs').Trade>>} */
  const byMint = new Map();
  for (const t of trades) {
    if (!byMint.has(t.mint)) byMint.set(t.mint, []);
    byMint.get(t.mint).push(t);
  }

  const metas = new Map();
  for (const mint of byMint.keys()) {
    // a classification outage must not discard a finished scan: unknown rows
    // beat no report (perStockSummary already renders a null meta as "unknown")
    try { metas.set(mint, await lookupToken(mint, { signal })); } catch { metas.set(mint, null); }
  }

  const rows = perStockSummary(byMint, (m) => metas.get(m));

  // flatten per-lot closings into one 1099-B style list; unknown-basis
  // disposals join as their own list — their gross proceeds are real and
  // belong in the statement even when the cost basis is unknowable
  const closes = [];
  const unknownCloses = [];
  for (const r of rows) {
    for (const c of r.closes ?? []) {
      closes.push({ symbol: r.symbol, mint: r.mint, ...c });
    }
    for (const u of r.unknownCloses ?? []) {
      unknownCloses.push({ symbol: r.symbol, mint: r.mint, ...u });
    }
  }
  closes.sort((a, b) => b.soldTs - a.soldTs);
  const disposals = [...closes, ...unknownCloses].sort((a, b) => b.soldTs - a.soldTs);

  return {
    rows,
    closes,
    unknownCloses,
    disposals,
    totalRealized: Math.round(rows.reduce((s, r) => s + r.realizedUsd, 0) * 100) / 100,
    totalAssumed: Math.round(rows.reduce((s, r) => s + (r.realizedAssumed ?? 0), 0) * 100) / 100,
    unknownBasis: rows.reduce((s, r) => s + (r.unknownBasis ?? 0), 0),
    // real disposals inside multi-token aggregator routes: lots are consumed,
    // but the cash cannot be split across legs — disclosed, never guessed
    aggregatedDisposals: trades.filter((t) => t.aggregated && t.side === "out").length,
    priceCorrections: trades.filter((t) => t.priceCorrected).length,
    // trades valued on their stable leg only (SOL price unavailable at scan
    // time): proceeds and P&L are understated — disclosed, never guessed
    partialCash: trades.filter((t) => t.partialCash).length,
    // of those, the legs unpriced because the day sits outside CoinGecko's
    // 365-day public window — a PERMANENT limit no rescan can recover, so a
    // consumer must tell it apart from a transient scan-time outage
    partialCashAncient: trades.filter((t) => t.partialCash && t.unpricedReason === "ancient").length,
    // fully unpriced movements (an ancient day outside every price window):
    // the shares still consumed FIFO lots with no proceeds and no P&L — a
    // different disclosure channel than partialCash (which covers partially
    // valued trades); without this counter the hole is silent
    unpricedMovements: trades.filter((t) => t.unpricedReason && !t.partialCash).length,
    // trades whose qty is a net of several material on-chain movements of one
    // mint (a sale plus a custody withdrawal): proceeds divided by a qty no
    // single fill supports — disclosed, never silent
    nettedMixed: trades.filter((t) => t.nettedMixed).length,
    tokens: rows.length,
  };
}
