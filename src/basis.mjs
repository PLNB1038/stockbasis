// FIFO cost basis.

// signature of the synthetic movements reconcile injects: they timestamp at
// scan time (after every real trade, by design) and must stay out of the
// activity window and any real-trade statistic
export const RECONCILE_SYNTHETIC = "chain-reconcile";

/**
 * @typedef {Object} Trade
 * @property {"buy"|"sell"|"out"|"in"} side   // out/in = withdrawals/deposits without cash leg
 * @property {number} qty        // units of the stock token
 * @property {number} valueUsd   // cash value of the whole trade (stablecoin leg)
 * @property {number} ts         // unix seconds
 * @property {number} [slot]     // on-chain slot — finer ordering inside one second
 */

/**
 * @typedef {Object} BasisResult
 * @property {number} realizedUsd     // total realized P&L (known-basis disposals only)
 * @property {number} realizedBuyUsd  // cost of lots consumed by sells
 * @property {Array<{acquiredTs:number, soldTs:number, qty:number, costUsd:number, proceedsUsd:number, pnlUsd:number}>} closes
 * @property {Array<{soldTs:number, qty:number, proceedsUsd:number}>} unknownBasis
 * @property {Array<{qty:number, costUsd:number, ts:number}>} openLots
 * @property {number} openQty
 * @property {number} openCostUsd
 */

/**
 * Compute FIFO cost basis over a chronologically sorted list of trades.
 * Always computes the strict variant (unknown basis excluded) plus, when
 * market prices are attached, an "assumed" variant where unknown-basis
 * disposals are valued at market (common tax-office convention).
 * @param {Trade[]} trades oldest-first
 * @returns {BasisResult}
 */
export function fifoBasis(trades) {
  // slot breaks ties inside one blockTime second (slot order == block order)
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || (a.slot ?? 0) - (b.slot ?? 0));
  /** @type {Array<{qty:number, costUsd:number, ts:number}>} */
  const lots = [];
  /** @type {Array<{qty:number, ts:number}>} deposited shares whose basis is unknowable */
  const unknownQ = [];
  /** @type {BasisResult["closes"]} */
  const closes = [];
  /** @type {Array<{ts:number, qty:number, proceedsUsd:number}>} */
  const unknownBasis = [];
  let realizedUsd = 0;
  let realizedBuyUsd = 0;
  let realizedAssumed = 0;

  // the optional market-basis assumption values unknown-basis disposals at a
  // market quote — but the quote is fetched at report time, so it is a fair
  // stand-in only for a RECENT disposal. Valuing an old sale against today's
  // spot would invent P&L out of thin air.
  const assumable = (t) => Number.isFinite(t.marketPx) && t.marketPx > 0
    && (t.marketPxAt ?? t.ts) - t.ts <= 7 * 86400;

  // a disposal consumes whichever inventory is older — known lots or earlier
  // custody deposits. Deposits-first is the conservative reading: when the
  // chain cannot say which shares were sold, profit is not invented.
  // Line items are rounded to cents AT CREATION and the totals sum those
  // atoms: a statement whose rows, CSV cells and grand total each round
  // independently cannot be reconciled against itself by an accountant.
  const consumeOldest = (need, perUnit, t) => {
    while (need >= 1e-12) {
      const lot = lots[0];
      const unk = unknownQ[0];
      const lotTs = lot ? lot.ts : Infinity;
      const unkTs = unk ? unk.ts : Infinity;
      if (lotTs === Infinity && unkTs === Infinity) break;
      if (unkTs <= lotTs) {
        const take = Math.min(unk.qty, need);
        const proceeds = cents(take * perUnit);
        unknownBasis.push({ soldTs: t.ts, qty: take, proceedsUsd: proceeds, pnlAssumedUsd: assumable(t) ? cents(proceeds - take * t.marketPx) : null });
        if (assumable(t)) {
          realizedAssumed += cents(proceeds - take * t.marketPx);
        }
        unk.qty -= take;
        need -= take;
        if (unk.qty <= 1e-12) unknownQ.shift();
      } else {
        const take = Math.min(lot.qty, need);
        const cost = cents((take / lot.qty) * lot.costUsd);
        const proceeds = cents(take * perUnit);
        realizedUsd += proceeds - cost;
        realizedAssumed += proceeds - cost; // assumed variant includes all known-basis P&L
        realizedBuyUsd += cost;
        closes.push({ acquiredTs: lot.ts, soldTs: t.ts, qty: take, costUsd: cost, proceedsUsd: proceeds, pnlUsd: cents(proceeds - cost) });
        lot.qty -= take;
        lot.costUsd -= cost;
        need -= take;
        if (lot.qty <= 1e-12) lots.shift();
      }
    }
    return need;
  };

  for (const t of sorted) {
    if (t.side === "buy") {
      // degenerate input never books a poison lot: a NaN/<=0 quantity or
      // non-finite value would corrupt every later close silently
      if (!(t.qty > 0) || !Number.isFinite(t.valueUsd)) continue;
      lots.push({ qty: t.qty, costUsd: t.valueUsd, ts: t.ts });
      continue;
    }

    // withdrawal: basis leaves the wallet with the tokens — consume whichever
    // inventory is older, no proceeds, no P&L (a movement, not a disposal)
    if (t.side === "out") {
      let need = t.qty;
      while (need >= 1e-12) {
        const lot = lots[0];
        const unk = unknownQ[0];
        const lotTs = lot ? lot.ts : Infinity;
        const unkTs = unk ? unk.ts : Infinity;
        if (lotTs === Infinity && unkTs === Infinity) break;
        if (unkTs <= lotTs) {
          const take = Math.min(unk.qty, need);
          unk.qty -= take;
          need -= take;
          if (unk.qty <= 1e-12) unknownQ.shift();
        } else {
          const take = Math.min(lot.qty, need);
          const cost = (take / lot.qty) * lot.costUsd;
          lot.qty -= take;
          lot.costUsd -= cost;
          need -= take;
          if (lot.qty <= 1e-12) lots.shift();
        }
      }
      continue;
    }
    if (t.side === "in") {
      // same rule as buys: a negative or NaN deposit corrupts the queue
      if (!(t.qty > 0)) continue;
      unknownQ.push({ qty: t.qty, ts: t.ts });
      continue;
    }

    // sell: consume inventory oldest-first (known lots book closes, custody
    // deposits book unknown-basis disposals). The epsilon is inclusive: the
    // smallest unit of a 12-decimals mint is exactly 1e-12 and must survive.
    if (!(t.qty > 0) || !Number.isFinite(t.valueUsd)) continue; // degenerate, never book NaN
    const need = consumeOldest(t.qty, t.valueUsd / t.qty, t);
    if (need >= 1e-12) {
      const proceeds = cents(need * (t.valueUsd / t.qty));
      unknownBasis.push({ soldTs: t.ts, qty: need, proceedsUsd: proceeds, pnlAssumedUsd: assumable(t) ? cents(proceeds - need * t.marketPx) : null });
      if (assumable(t)) {
        realizedAssumed += cents(proceeds - need * t.marketPx);
      }
    }
  }

  const openQty = lots.reduce((s, l) => s + l.qty, 0);
  const openCostUsd = lots.reduce((s, l) => s + l.costUsd, 0);
  const openUnknownQty = unknownQ.reduce((s, u) => s + u.qty, 0);
  return { realizedUsd, realizedAssumed, realizedBuyUsd, closes, unknownBasis, openLots: lots, openQty, openCostUsd, openUnknownQty };
}

/**
 * Roll up per-stock summary.
 * @param {Map<string, Trade[]>} tradesByMint
 * @param {(mint: string) => {symbol: string, name: string} | undefined} meta
 * @returns {Array<object>} one row per stock token
 */
export function perStockSummary(tradesByMint, meta) {
  const rows = [];
  for (const [mint, trades] of tradesByMint) {
    const b = fifoBasis(trades);
    const m = meta(mint) ?? { symbol: mint.slice(0, 6), name: "unknown" };
    // the activity window covers REAL trades only: a reconcile adjustment
    // lands at scan time ("after every trade" by design) and would stretch
    // the window months past the last actual swap
    const realTs = trades.filter((t) => t.signature !== RECONCILE_SYNTHETIC).map((t) => t.ts);
    // break-even (pnl exactly 0) is neither a win nor a loss
    const wins = b.closes.filter((c) => c.pnlUsd > 0).length;
    const losses = b.closes.filter((c) => c.pnlUsd < 0).length;
    rows.push({
      mint,
      symbol: m.symbol,
      name: m.name,
      trades: trades.filter((t) => t.side === "buy" || t.side === "sell").length,
      buys: trades.filter((t) => t.side === "buy").length,
      sells: trades.filter((t) => t.side === "sell").length,
      wins,
      losses,
      unknownBasis: b.unknownBasis.length,
      unknownCloses: b.unknownBasis, // per-disposal details: gross proceeds belong in the statement even without basis
      realizedAssumed: round(b.realizedAssumed, 2),
      closes: b.closes,
      realizedUsd: round(b.realizedUsd, 2),
      // 12 decimals survive the round trip: a single unit of a 9-decimals mint
      // is a real position, and the renderer already formats for display
      openQty: round(b.openQty, 12),
      openUnknownQty: round(b.openUnknownQty, 12),
      openCostUsd: round(b.openCostUsd, 2),
      firstTs: realTs.length ? Math.min(...realTs) : undefined,
      lastTs: realTs.length ? Math.max(...realTs) : undefined,
    });
  }
  return rows.sort((a, b) => Math.abs(b.realizedUsd) - Math.abs(a.realizedUsd));
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const cents = (x) => Math.round(x * 100) / 100;
