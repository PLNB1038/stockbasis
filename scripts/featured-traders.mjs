// Resolve each symbol to its deepest pool, then collect writable signers of
// recent pool transactions — candidates for the featured list on the landing page.
//   node scripts/featured-traders.mjs SPYx OPENAI DKNG [txsPerPool]

import { readFileSync } from "node:fs";
import { rpc } from "../src/rpc.mjs";

const symbols = process.argv.slice(2, -isNaN(Number(process.argv.at(-1))) ? undefined : -1);
const perPool = Number(process.argv.at(-1)) > 0 ? Number(process.argv.at(-1)) : 12;
const stocks = JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url)));

// signature reads that failed — counted across the run and announced at the
// end: unlike every other skip in this file, a dead getTransaction used to
// vanish into a silent null and shrink the ranking with no message at all
let unreadableReads = 0;
let lastReadErr = null;

for (const sym of symbols) {
  const mint = Object.entries(stocks).find(([, v]) => v.symbol === sym)?.[0];
  if (!mint) { console.error(`(skip ${sym}: not in data/stocks.json)`); continue; }

  // a routine 429 or an HTML error page must not kill the whole run: skip the
  // symbol and keep going, symmetric with the rpc leg below
  let pairs;
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    pairs = await res.json();
  } catch (e) {
    console.error(`(skip ${sym}: dexscreener unavailable: ${e.message})`);
    continue;
  }
  // an error envelope (a proxy/Cloudflare {"error":...} body, a bare "Forbidden"
  // string) parses fine but is not a pair list: `?? []` only guards null, so a
  // .sort TypeError here would kill the whole run — same skip-and-continue as
  // the outage above
  if (!Array.isArray(pairs)) {
    console.error(`(skip ${sym}: dexscreener answered a non-list body: ${JSON.stringify(pairs)?.slice(0, 60)})`);
    continue;
  }
  const pool = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pool) { console.error(`(skip ${sym}: no pool)`); continue; }
  console.error(`[${sym}] pool ${pool.pairAddress} (liq $${Math.round((pool.liquidity?.usd ?? 0) / 1000)}k)`);

  const sigs = await rpc("getSignaturesForAddress", [pool.pairAddress, { limit: 100 }]).catch((e) => { console.error("  rpc:", e.message); return []; });
  /** @type {Map<string, number>} */
  const traders = new Map();

  for (const s of sigs.slice(0, perPool)) {
    if (s.err) continue;
    // maxSupportedTransactionVersion 1 — the ingest.mjs rule: a version-0
    // request dies with RPC -32015 on a version-1 transaction, and the catch
    // below would then silently drop it — a trader whose pool activity is
    // v1-shaped disappears from the ranking with no skip message
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]).catch((e) => { unreadableReads++; lastReadErr = e; return null; });
    for (const k of tx?.transaction?.message?.accountKeys ?? []) {
      if (k.pubkey === pool.pairAddress || !k.signer || !k.writable) continue;
      traders.set(k.pubkey, (traders.get(k.pubkey) ?? 0) + 1);
    }
  }
  console.log(`# ${sym}`);
  for (const [addr, n] of [...traders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`${n}  ${addr}`);
}

if (unreadableReads) {
  console.error(`note: ${unreadableReads} signature read${unreadableReads === 1 ? "" : "s"} failed (last: ${String(lastReadErr?.message ?? lastReadErr).slice(0, 120)}) — those transactions were skipped, not ranked`);
}
