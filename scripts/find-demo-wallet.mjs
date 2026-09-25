// Walk a pool's recent transactions and rank writable signers.
//   node scripts/find-demo-wallet.mjs <poolAddress> [txsToScan]

import { rpc } from "../src/rpc.mjs";

const pool = process.argv[2];
const maxScan = Number(process.argv[3] ?? 25);
// Number.isFinite gate: Number("abc") is NaN, JSON.stringify turns NaN into
// null inside the request body and a strict mirror answers -32602 — the usage
// line is the honest answer, not a stack trace
if (!pool || !Number.isFinite(maxScan) || maxScan <= 0) {
  console.error("usage: node scripts/find-demo-wallet.mjs <poolAddress> [txsToScan]");
  process.exit(1);
}

// one failure must end in a message, not a crash (a rejected rpc, a null
// answer from every mirror, a non-list result) — the same shape pick-featured
// uses around each wallet
try {
  const sigs = (await rpc("getSignaturesForAddress", [pool, { limit: Math.min(maxScan, 1000) }])) ?? [];
  console.error(`[find-demo] pool has ${sigs.length} recent signatures, scanning...`);

  /** @type {Map<string, number>} */
  const traders = new Map();

  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch(() => null);
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
} catch (e) {
  console.error(`[find-demo] ${String(pool).slice(0, 8)}… failed: ${String(e?.message ?? e).slice(0, 80)}`);
  process.exitCode = 1;
}
