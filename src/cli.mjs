// CLI entry points:
//   node src/cli.mjs report  <address>   print a P&L report to the terminal
//   node src/cli.mjs csv     <address>   write stockbasis-<address>.csv
//   node src/cli.mjs scan    <address>   debug: list equity tokens the wallet touched

import { ingestWallet } from "./ingest.mjs";
import { buildReport } from "./report.mjs";
import { lookupToken } from "./classify.mjs";
import { toCsv } from "./csv.mjs";

const [, , cmd, address] = process.argv;
if (!cmd || !address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
  console.error("usage: node src/cli.mjs <report|csv|scan> <wallet-address>");
  process.exit(1);
}

console.error(`[stockbasis] scanning ${address} ...`);
const { trades, transfers, seen, coverage } = await ingestWallet(address, {
  maxScanTx: Number(process.env.INGEST_MAX_SCAN_TX ?? 1500),
  targetStockTrades: Number(process.env.INGEST_TARGET_TRADES ?? 30),
  onProgress: (p) => { if (p.scanned % 50 === 0) console.error(`  ...${p.scanned} txs, ${p.trades} stock trades`); },
});
console.error(`[stockbasis] ${seen} txs → ${trades.length} trades, ${transfers.length} transfers`);

if (cmd === "scan") {
  const mints = [...new Set(trades.map((t) => t.mint))];
  for (const mint of mints) {
    const m = await lookupToken(mint);
    console.log(mint, m?.symbol, m?.isStock ? "STOCK" : "-");
  }
  process.exit(0);
}

const { rows, closes, totalRealized } = await buildReport(trades);

if (cmd === "csv") {
  const file = `stockbasis-${address.slice(0, 8)}.csv`;
  await import("node:fs").then((fs) => fs.writeFileSync(file, toCsv(closes)));
  console.error(`[stockbasis] wrote ${file} (${closes.length} disposals)`);
} else {
  console.table(rows.map(({ mint, ...r }) => ({ symbol: r.symbol, trades: r.trades, realizedUsd: r.realizedUsd, openQty: r.openQty, openCostUsd: r.openCostUsd })));
  console.log(`TOTAL realized P&L: ${totalRealized.toFixed(2)} USD across ${rows.length} stock tokens`);
  if (coverage?.fromTs) {
    const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
    console.log(`history covered: ${day(coverage.fromTs)} → ${day(coverage.toTs)} (${coverage.scanned} txs scanned)`);
  }
}
