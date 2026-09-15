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

const cache = new Map(); // mint -> { symbol, name, isStock, tags } | { isNull, nullUntil }
// finite-or-default: a NaN TTL from a typo'd env var would make every null
// cache entry expire instantly (or never) without any signal
const NULL_TTL_MS = Number.isFinite(Number(process.env.CLASSIFY_NULL_TTL_MS)) ? Number(process.env.CLASSIFY_NULL_TTL_MS) : 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// token metadata is attacker-controllable: strip control characters AND
// bidi/zero-width format characters at the source — a spoofed symbol must
// not render indistinguishably from a real ticker next to real money
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");

/**
 * Look up token metadata and stock classification for a mint.
 * A "no data" answer is cached only for a short TTL: an index-lagging mirror
 * must not blind the process to a stock for its whole lifetime.
 * @param {string} mint
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{symbol: string, name: string, isStock: boolean, tags: string[]} | null>}
 */
export async function lookupToken(mint, { signal } = {}) {
  const hit = cache.get(mint);
  if (hit !== undefined) {
    if (!hit.isNull) return hit;
    if (Date.now() < hit.nullUntil) return null;
    cache.delete(mint); // stale no-data: ask again
  }

  if (curated[mint]) {
    const out = { symbol: clean(curated[mint].symbol), name: clean(curated[mint].name), isStock: true, tags: ["curated"] };
    cache.set(mint, out);
    return out;
  }

  let out = null;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error(`token lookup aborted: ${mint}`);
    const res = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(mint)}`,
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
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
      out = { symbol: clean(t.symbol ?? "?"), name: clean(t.name ?? ""), isStock: tags.some((x) => STOCK_TAGS.has(x)), tags };
    }
    break;
  }
  // positive answers are immutable; no-data is only as durable as its TTL
  cache.set(mint, out ?? { isNull: true, nullUntil: Date.now() + NULL_TTL_MS });
  await sleep(250); // free tier QPS is low
  return out;
}

/** Test hook: seed the cache so fixture tests never touch the network. */
export function primeTokenCache(mint, meta) {
  cache.set(mint, { ...meta, symbol: clean(meta?.symbol), name: clean(meta?.name) });
}

/** Stablecoins we treat as the cash leg of a trade (mint addresses verified on-chain). */
export const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (PayPal/Paxos)
]);
