// Ground-truth verification: for wallets with scanned positions, the report's
// open qty per token must equal the REAL on-chain token balance right now.
// Mismatches mean reconstruction bugs (missed buys/sells/transfers).
//
//   node scripts/verify-open-positions.mjs <addr1> <addr2> ...

import { rpc } from "../src/rpc.mjs";
import { ingestWallet } from "../src/ingest.mjs";
import { buildReport } from "../src/report.mjs";

for (const address of process.argv.slice(2)) {
  const { trades } = await ingestWallet(address, { maxScanTx: 8000, targetStockTrades: 300, timeBudgetS: 300 });
  const report = await buildReport(trades);

  let checked = 0;
  let mismatches = [];
  for (const row of report.rows) {
    const res = await rpc("getTokenAccountsByOwner", [
      address,
      { mint: row.mint, encoding: "jsonParsed" },
    ]).catch(() => null);
    const accounts = res?.value ?? [];
    let onChain = 0;
    for (const a of accounts) onChain += a.account.data.parsed.info.tokenAmount.uiAmount ?? 0;

    const claimed = (row.openQty ?? 0) + (row.openUnknownQty ?? 0);
    if (claimed < 1e-9 && onChain < 1e-9) continue;
    checked++;
    const diff = Math.abs(onChain - claimed);
    const tol = Math.max(1e-6, onChain * 0.01); // 1% tolerance for races between scan and now
    if (diff > tol) {
      const dir = claimed > onChain ? "tool holds phantom (missed transfer-out)" : "chain holds more (custody transfer-in)";
      mismatches.push(`${row.symbol}: tool ${claimed.toFixed(6)} vs chain ${onChain.toFixed(6)} — ${dir}`);
    }
  }

  const verdict = mismatches.length ? "MISMATCH" : "OK";
  console.log(`${address.slice(0, 8)}… | rows ${report.rows.length} | open positions checked: ${checked} | ${verdict}`);
  for (const m of mismatches) console.log(`   ${m}`);
}
