// Stock tokens are tagged ('stocks', 'equities', 'xstocks', 'ondo') by Jupiter;
// meme lookalikes come back 'unknown', so the tags do the filtering.
// data/stocks.json (curated universe) answers first, no API call needed.

import { readFileSync } from "node:fs";

const STOCK_TAGS = new Set(["stocks", "equities", "xstocks", "ondo"]);
const SEARCH_URL = process.env.JUP_SEARCH_URL ?? "https://lite-api.jup.ag/tokens/v2/search";

const curated = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url), "utf8"));
  } catch (e) {
    // a broken curated file must be as loud as a broken featured.json (the
    // strip re-reads per request and flags itself): a silent {} here reads as
    // "no curated stocks" to every lookup, un-Stocking the whole curated
    // universe exactly when the Jupiter fallback lags too
    console.error(`[stockbasis] curated universe load failed: ${String(e?.message ?? e).slice(0, 120)}`);
    return {};
  }
})();

const cache = new Map(); // mint -> { symbol, name, isStock, tags } | { isNull, nullUntil }
// finite-or-default, empty included: Number("") is 0 and 0 IS finite, so a
// bare isFinite gate lets an empty env var expire the no-data cache
// instantly — every repeat lookup would hit Jupiter again (and its 250ms+
// pacing), silently stretching scan time and burning free-tier quota.
// (Local copy: importing the shared helper from ingest.mjs would be a cycle.)
const envInt = (v, dflt) => {
  if (v == null || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const NULL_TTL_MS = envInt(process.env.CLASSIFY_NULL_TTL_MS, 10 * 60 * 1000);
// a 200 answer whose tags are still empty is not positive: Jupiter knows the
// token but has not indexed its tags yet (the same listing lag as no-data).
// It gets a short TTL of its own so a freshly listed stock surfaces on the
// next lookup instead of staying invisible until a process restart.
const TAGLESS_TTL_MS = envInt(process.env.CLASSIFY_TAGLESS_TTL_MS, 30 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// token metadata is attacker-controllable: strip control characters AND
// bidi/zero-width format characters at the source — a spoofed symbol must
// not render indistinguishably from a real ticker next to real money
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
// and length: symbol/name come from the issuer of the mint, so a hostile one
// can park megabytes in the cache through a single visitor's scan
const fit = (s, n) => clean(s).slice(0, n);

const MAX_TOKEN_CACHE = 1024;
// insertion-order eviction keeps the map bounded: a displaced entry only
// costs a re-lookup later (curated answers re-hit instantly), correctness is
// untouched — only the unbounded memory of immortal positives is
function remember(mint, entry) {
  if (cache.size >= MAX_TOKEN_CACHE) cache.delete(cache.keys().next().value);
  cache.set(mint, entry);
}

/**
 * Look up token metadata and stock classification for a mint.
 * A "no data" answer is cached only for a short TTL: an index-lagging mirror
 * must not blind the process to a stock for its whole lifetime. The same
 * applies to a tagless answer (token known, tags not indexed yet): it expires
 * after TAGLESS_TTL_MS so the tag is picked up without a restart.
 * @param {string} mint
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{symbol: string, name: string, isStock: boolean, tags: string[]} | null>}
 */
export async function lookupToken(mint, { signal } = {}) {
  const hit = cache.get(mint);
  if (hit !== undefined) {
    if (!hit.isNull) {
      if (hit.unconfirmedUntil === undefined || Date.now() < hit.unconfirmedUntil) return hit;
      cache.delete(mint); // stale tagless answer: the tags may have arrived — ask again
    } else if (Date.now() < hit.nullUntil) {
      return null;
    } else {
      cache.delete(mint); // stale no-data: ask again
    }
  }

  if (curated[mint]) {
    const out = { symbol: fit(curated[mint].symbol, 64), name: fit(curated[mint].name, 128), isStock: true, tags: ["curated"] };
    remember(mint, out);
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
      out = { symbol: fit(t.symbol ?? "?", 64), name: fit(t.name ?? "", 128), isStock: tags.some((x) => STOCK_TAGS.has(x)), tags };
    }
    break;
  }
  // answers that carry tags are immutable; a tagless one is only as durable
  // as its short TTL (tags may be indexed any moment), and no-data as its own
  remember(mint,
    out === null ? { isNull: true, nullUntil: Date.now() + NULL_TTL_MS }
    : out.tags.length === 0 ? { ...out, unconfirmedUntil: Date.now() + TAGLESS_TTL_MS }
    : out);
  await sleep(250); // free tier QPS is low
  return out;
}

/** Test hook: the bounded-cache invariant is observable without network. */
export function tokenCacheSize() {
  return cache.size;
}

/** Test hook: seed the cache so fixture tests never touch the network. */
export function primeTokenCache(mint, meta) {
  remember(mint, { ...meta, symbol: fit(meta?.symbol, 64), name: fit(meta?.name, 128) });
}

/** Stablecoins we treat as the cash leg of a trade (mint addresses verified on-chain). */
export const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (PayPal/Paxos)
]);
