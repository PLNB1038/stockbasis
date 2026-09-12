// Resolve each symbol to its deepest pool, then collect writable signers of
// recent pool transactions — candidates for the featured list on the landing page.
//   node scripts/featured-traders.mjs SPYx OPENAI DKNG [txsPerPool]

import { readFileSync } from "node:fs";
import { rpc } from "../src/rpc.mjs";

const symbols = process.argv.slice(2, -isNaN(Number(process.argv.at(-1))) ? undefined : -1);
const perPool = Number(process.argv.at(-1)) > 0 ? Number(process.argv.at(-1)) : 12;
const stocks = JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url)));

for (const sym of symbols) {
  const mint = Object.entries(stocks).find(([, v]) => v.symbol === sym)?.[0];
  if (!mint) { console.error(`(skip ${sym}: not in data/stocks.json)`); continue; }

  const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const pairs = await res.json();
  const pool = (pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pool) { console.error(`(skip ${sym}: no pool)`); continue; }
  console.error(`[${sym}] pool ${pool.pairAddress} (liq $${Math.round((pool.liquidity?.usd ?? 0) / 1000)}k)`);

  const sigs = await rpc("getSignaturesForAddress", [pool.pairAddress, { limit: 100 }]).catch((e) => { console.error("  rpc:", e.message); return []; });
  /** @type {Map<string, number>} */
  const traders = new Map();

  for (const s of sigs.slice(0, perPool)) {
    if (s.err) continue;
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
    for (const k of tx?.transaction?.message?.accountKeys ?? []) {
      if (k.pubkey === pool.pairAddress || !k.signer || !k.writable) continue;
      traders.set(k.pubkey, (traders.get(k.pubkey) ?? 0) + 1);
    }
  }
  console.log(`# ${sym}`);
  for (const [addr, n] of [...traders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`${n}  ${addr}`);
}
