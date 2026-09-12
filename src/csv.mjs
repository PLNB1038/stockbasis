// CSV export: per-disposal rows, 1099-B style.

/**
 * @param {Array<object>} closes flattened lot closings (symbol attached)
 * @returns {string}
 */
export function toCsv(closes) {
  const head = "symbol,mint,acquired_date,sold_date,qty,proceeds_usd,cost_basis_usd,gain_usd";
  const esc = (v) => {
    let s = String(v ?? "");
    // spreadsheet formula injection: neutralize cells Excel would execute
    if (/^[=+\-@]/.test(s.trimStart())) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown");
  const lines = closes.map((c) =>
    [c.symbol, c.mint, iso(c.acquiredTs), iso(c.soldTs), c.qty, c.proceedsUsd.toFixed(2), c.costUsd.toFixed(2), c.pnlUsd.toFixed(2)]
      .map(esc)
      .join(",")
  );
  return [head, ...lines].join("\n") + "\n";
}
