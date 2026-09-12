// Dev helper: find real tokenized-stock traders to use as demo wallets.
//
// Walks the recent history of a liquidity pool (e.g. a Raydium TSLAx/USDC pair),
// extracts signer addresses from its transactions and counts their activity.
// Pools have enormous histories; traders appear as co-signers.
//
//   node scripts/find-demo-wallet.mjs <poolAddress> [txsToScan]

import { rpc } from "../src/rpc.mjs";

const pool = process.argv[2];
const maxScan = Number(process.argv[3] ?? 25);
if (!pool) {
  console.error("usage: node scripts/find-demo-wallet.mjs <poolAddress> [txsToScan]");
  process.exit(1);
}

const sigs = await rpc("getSignaturesForAddress", [pool, { limit: Math.min(maxScan, 1000) }]);
console.error(`[find-demo] pool has ${sigs.length} recent signatures, scanning...`);

/** @type {Map<string, number>} */
const traders = new Map();

for (const s of sigs) {
  if (s.err) continue;
  const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
  if (!tx?.transaction?.message?.accountKeys) continue;

  for (const k of tx.transaction.message.accountKeys) {
    if (k.pubkey === pool || k.signer !== true || k.writable !== true) continue;
    traders.set(k.pubkey, (traders.get(k.pubkey) ?? 0) + 1);
  }
  console.error(`  [${traders.size} wallets] scanned ${sigs.indexOf(s) + 1}/${sigs.length}`);
}

const top = [...traders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("\nTop candidate wallets (writable signers of pool trades):");
for (const [addr, n] of top) console.log(`${String(n).padStart(3)} txs  ${addr}`);
