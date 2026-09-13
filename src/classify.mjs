// Stock tokens are tagged ('stocks', 'equities', 'xstocks', 'ondo') by Jupiter;
// meme lookalikes come back 'unknown', so the tags do the filtering.
// data/stocks.json (curated universe) answers first, no API call needed.

import { readFileSync } from "node:fs";

const STOCK_TAGS = new Set(["stocks", "equities", "xstocks", "ondo"]);
const SEARCH_URL = process.env.JUP_SEARCH_URL ?? "https://lite-api.jup.ag/tokens/v2/search";

const curated = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
})();

const cache = new Map(); // mint -> { symbol, name, isStock, tags }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up token metadata and stock classification for a mint.
 * @param {string} mint
 * @returns {Promise<{symbol: string, name: string, isStock: boolean, tags: string[]} | null>}
 */
export async function lookupToken(mint) {
  if (cache.has(mint)) return cache.get(mint);

  if (curated[mint]) {
    const out = { symbol: curated[mint].symbol, name: curated[mint].name, isStock: true, tags: ["curated"] };
    cache.set(mint, out);
    return out;
  }

  let out = null;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429 && attempt < 4) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Jupiter search HTTP ${res.status} for ${mint}`);
    const items = await res.json();
    // a non-array body (error object, gateway page) is a "no data" answer, not
    // a crash: cache null and keep the rest of the transaction trading
    const t = (Array.isArray(items) ? items.find((x) => x.id === mint) : undefined) ?? null;
    if (t) {
      const tags = t.tags ?? [];
      out = { symbol: t.symbol ?? "?", name: t.name ?? "", isStock: tags.some((x) => STOCK_TAGS.has(x)), tags };
    }
    break;
  }
  cache.set(mint, out); // mints are immutable; cache forever
  await sleep(250); // free tier QPS is low
  return out;
}

/** Test hook: seed the cache so fixture tests never touch the network. */
export function primeTokenCache(mint, meta) {
  cache.set(mint, meta);
}

/** Stablecoins we treat as the cash leg of a trade. */
export const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDSfrMwLsBiaaPZonNncG1FzGZYzkNk3ZhzV8R9bF", // USDS
]);
