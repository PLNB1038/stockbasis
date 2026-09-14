// WSOL cash legs need a SOL price; USDC/USDT legs are already dollar-denominated.

const dayCache = new Map(); // yyyy-mm-dd -> usd
const missCache = new Map(); // yyyy-mm-dd -> Date.now() of the last failed lookup
const MISS_TTL_MS = 5 * 60 * 1000;

/**
 * SOL price at a given unix timestamp (per-day resolution, cached).
 * Falls back to the current price when history is unavailable.
 * @param {number} ts unix seconds
 */
export async function solUsdOn(ts) {
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  if (dayCache.has(day)) return dayCache.get(day);
  // a throttling API must not be re-asked per trade: without the miss cache a
  // 429 day burns 2 fetch timeouts + backoff on EVERY WSOL trade of that day
  const miss = missCache.get(day);
  if (miss && Date.now() - miss < MISS_TTL_MS) return null;
  const usd = await fromCoinGeckoHistory(day);
  if (usd != null) dayCache.set(day, usd);
  else missCache.set(day, Date.now());
  return usd; // null → caller must treat the cash leg as unpriced
}

/** Test hook: seed a known day price so fixtures stay deterministic. */
export function primeSolDayCache(ts, usd) {
  dayCache.set(new Date(ts * 1000).toISOString().slice(0, 10), usd);
}

async function fromCoinGeckoHistory(day) {
  const [y, m, d] = day.split("-");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/solana/history?date=${d}-${m}-${y}`, { signal: AbortSignal.timeout(6000) });
      if (res.status === 429 && attempt === 0) continue; // free tier throttles by minute
      if (!res.ok) return null;
      const p = (await res.json())?.market_data?.current_price?.usd;
      return Number.isFinite(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}
