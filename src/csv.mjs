// CSV export: per-disposal rows, 1099-B style.

/**
 * @param {Array<object>} closes flattened lot closings (symbol attached)
 * @returns {string}
 */
export function toCsv(closes) {
  const head = "symbol,mint,acquired_date,sold_date,qty,proceeds_usd,cost_basis_usd,gain_usd,assumed_gain_usd";
  const esc = (v) => {
    let s = String(v ?? "");
    // spreadsheet formula injection: neutralize cells Excel would execute;
    // pure numbers stay numeric even when negative — a leading apostrophe
    // would turn P&L values into text in spreadsheets
    if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@]/.test(s.trimStart())) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown");
  // sub-milli quantities are real movements: show up to 9 decimals instead of
  // rounding a booked disposal into a "0" ghost row; trailing zeros go away
  const qty = (v) => {
    const d = v !== 0 && Math.abs(v) < 1e-3 ? 9 : 6;
    return v.toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };
  // unknown-basis rows carry no cost/gain — an empty cell, never a guess;
  // the assumed column prices the same disposal at the market quote so the
  // file never contradicts what the toggle on screen just showed
  const money = (v) => (v == null ? "" : v.toFixed(2));
  const lines = closes.map((c) =>
    [c.symbol, c.mint, iso(c.acquiredTs), iso(c.soldTs), qty(c.qty), c.proceedsUsd.toFixed(2), money(c.costUsd), money(c.pnlUsd), money(c.pnlAssumedUsd)]
      .map(esc)
      .join(",")
  );
  // the BOM makes Excel decode the file as UTF-8 on double-click instead of
  // mangling non-ASCII tickers through an ANSI code page
  return "\uFEFF" + [head, ...lines].join("\n") + "\n";
}
