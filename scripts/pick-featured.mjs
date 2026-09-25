// One verdict line per wallet: buys/sells, W/L, unknown-basis share.
//   node scripts/pick-featured.mjs <addr1> <addr2> ... [maxScanTx]

import { ingestWallet } from "../src/ingest.mjs";
import { buildReport } from "../src/report.mjs";

const args = process.argv.slice(2);
// a bare numeric tail is the scan cap — but ONLY when it cannot be a base58
// address: every Solana address is 32+ chars, so 1-10 digits are a limit and
// an all-digit address (they exist) stays an address. The old Number()>0
// probe swallowed a digits-only address into the cap: the address list went
// empty and the script silently did nothing.
const isLimit = (s) => /^\d{1,10}$/.test(s ?? "");
const maxScanTx = isLimit(args.at(-1)) ? Number(args.at(-1)) : 400;
const addresses = isLimit(args.at(-1)) ? args.slice(0, -1) : args;

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
