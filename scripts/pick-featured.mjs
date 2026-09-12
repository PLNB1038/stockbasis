// Dev helper: score candidate wallets for the featured list.
// Runs a bounded scan per address and prints one verdict line each —
// pick wallets with buys AND sells, mixed W/L, and a low unknown-basis share.
//
//   node scripts/pick-featured.mjs <addr1> <addr2> ... [maxScanTx]

import { ingestWallet } from "../src/ingest.mjs";
import { buildReport } from "../src/report.mjs";

const args = process.argv.slice(2);
const maxScanTx = Number(args.at(-1)) > 0 ? Number(args.at(-1)) : 400;
const addresses = Number(args.at(-1)) > 0 ? args.slice(0, -1) : args;

for (const address of addresses) {
  try {
    const { trades } = await ingestWallet(address, { maxScanTx, targetStockTrades: 12, timeBudgetS: 35 });
    const report = await buildReport(trades);
    const buys = report.rows.reduce((s, r) => s + r.buys, 0);
    const sells = report.rows.reduce((s, r) => s + r.sells, 0);
    const wins = report.rows.reduce((s, r) => s + r.wins, 0);
    const losses = report.rows.reduce((s, r) => s + r.losses, 0);
    const symbols = report.rows.slice(0, 3).map((r) => r.symbol).join("/");
    const mixed = buys > 0 && sells > 0 && wins > 0 && losses > 0 ? "MIXED" : "skew";
    console.log(
      `${address} | ${report.tokens} stocks (${symbols}) | ${report.totalRealized >= 0 ? "+" : ""}$${report.totalRealized.toLocaleString("en-US")} | ` +
      `${buys}B/${sells}S | ${wins}W/${losses}L | unk ${report.unknownBasis} | ${mixed}`
    );
  } catch (e) {
    console.log(`${address} | ERROR ${String(e?.message ?? e).slice(0, 60)}`);
  }
}
