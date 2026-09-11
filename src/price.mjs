// WSOL cash legs need a SOL price; USDC/USDT legs are already dollar-denominated.

const dayCache = new Map(); // yyyy-mm-dd -> usd
let cached = null; // { usd, at }

/**
 * SOL price at a given unix timestamp (per-day resolution, cached).
 * Falls back to the current price when history is unavailable.
 * @param {number} ts unix seconds
 */
export async function solUsdOn(ts) {
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  if (dayCache.has(day)) return dayCache.get(day);
  const usd = (await fromCoinGeckoHistory(day)) ?? (await solUsd());
  dayCache.set(day, usd);
  return usd;
}

async function fromCoinGeckoHistory(day) {
  const [y, m, d] = day.split("-");
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/solana/history?date=${d}-${m}-${y}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const p = (await res.json())?.market_data?.current_price?.usd;
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Current SOL price in USD. Cached for 10 minutes; falls back through
 * a couple of free sources and finally to $1 (the old approximation).
 * @returns {Promise<number>}
 */
export async function solUsd() {
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.usd;

  const usd = (await fromCoinGecko()) ?? (await fromJupiter()) ?? 1;
  cached = { usd, at: Date.now() };
  return usd;
}

async function fromCoinGecko() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const p = (await res.json())?.solana?.usd;
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

async function fromJupiter() {
  try {
    const res = await fetch("https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const p = (await res.json())?.data?.So11111111111111111111111111111111111111112?.price;
    const n = Number(p);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
