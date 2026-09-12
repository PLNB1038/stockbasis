// Trades from on-chain history: diff meta.preTokenBalances vs meta.postTokenBalances
// per tx. Equity deltas paired with an opposite stablecoin/WSOL delta are buys/sells;
// unpaired equity movements are transfers, kept out of the basis.
//
// Scan is adaptive, newest-first: keep going until enough stock trades are found
// or a tx/time budget runs out. fifoBasis sorts by ts, so append order doesn't matter.

import { rpc, allSignatures, RpcError } from "./rpc.mjs";
import { lookupToken, STABLES } from "./classify.mjs";
import { solUsdOn } from "./price.mjs";

/** WSOL mint (wrapped SOL acts as the cash leg in many swaps). */
export const WSOL = "So11111111111111111111111111111111111111112";

/**
 * @typedef {Object} Trade
 * @property {"buy"|"sell"} side
 * @property {string} mint
 * @property {number} qty
 * @property {number} valueUsd
 * @property {number} ts
 * @property {string} signature
 */

/**
 * Pull the full trade history for one address.
 * @param {string} address
 * @param {{rpcUrl?: string, onProgress?: (done: number) => void}} [opts]
 * @returns {Promise<{trades: Trade[], transfers: object[], seen: number}>}
 */
export async function ingestWallet(address, opts = {}) {
  const sigs = [];
  for await (const s of allSignatures(address, opts)) {
    if (s.err) continue; // failed txs changed nothing
    sigs.push(s);
    opts.onWalk?.(sigs.length);
    if (sigs.length >= (opts.maxScanTx ?? 1500)) break; // no point walking past the fetch budget
  }
  // allSignatures yields newest-first; scan that direction and stop on budget
  /** @type {Trade[]} */
  const trades = [];
  const transfers = [];
  const started = Date.now();
  const maxTx = opts.maxScanTx ?? 1500;
  const target = opts.targetStockTrades ?? 30;
  const timeBudgetMs = (opts.timeBudgetS ?? 100) * 1000;
  let scanned = 0;

  for (let i = 0; i < sigs.length; i += TX_CONCURRENCY) {
    if (scanned >= maxTx || trades.length >= target || Date.now() - started > timeBudgetMs) break;

    const chunk = sigs.slice(i, i + TX_CONCURRENCY);
    const txs = await Promise.all(chunk.map((s) => fetchTx(s).catch(() => null)));

    for (let j = 0; j < chunk.length; j++) {
      const tx = txs[j];
      const s = chunk[j];
      scanned++;
      if (!tx?.meta) continue;
      const deltas = tokenDeltas(tx.meta, address);
      if (!deltas.length) continue;
      const ctx = {
        ts: s.blockTime ?? 0,
        signature: s.signature,
        solDelta: walletSolDelta(tx, address), // lamports; catches WSOL legs that open+close in one tx
      };
      await pairTrades(deltas, ctx, trades, transfers);
    }
    opts.onProgress?.({ scanned, trades: trades.length, budget: maxTx });
  }

  const { corrected, ambiguous } = await priceSanityGate(trades);
  // sigs/trades arrive newest-first; FIFO relies on stable same-second order,
  // so hand the pipeline an oldest-first array
  trades.reverse();
  const lastFetched = sigs[Math.min(scanned, sigs.length) - 1]; // sigs are newest-first

  return {
    trades,
    transfers,
    seen: scanned,
    corrected,
    ambiguous,
    coverage: { fromTs: lastFetched?.blockTime ?? null, toTs: sigs[0]?.blockTime ?? null, scanned },
  };
}

const TX_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 5);

/**
 * Aggregator routes make cash-leg pairing ambiguous. Trades whose implied
 * price is far off market are repriced at market when recent; older ones are
 * dropped entirely — a current spot price must not rewrite month-old history.
 */
async function priceSanityGate(trades) {
  if (!trades.length) return { corrected: 0, ambiguous: 0 };
  const mints = [...new Set(trades.map((t) => t.mint))];
  let prices;
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { corrected: 0, ambiguous: 0 };
    const pairs = await res.json();
    prices = new Map();
    for (const p of pairs ?? []) {
      const base = p.baseToken?.address;
      const px = Number(p.priceUsd);
      const liq = p.liquidity?.usd ?? 0;
      if (!base || !Number.isFinite(px) || px <= 0) continue;
      const prev = prices.get(base);
      if (!prev || liq > prev.liq) prices.set(base, { px, liq });
    }
    for (const [base, v] of prices) prices.set(base, v.px);
  } catch {
    return { corrected: 0, ambiguous: 0 }; // no market data — leave trades as paired
  }

  let corrected = 0;
  let ambiguousCount = 0;
  const now = Date.now() / 1000;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    const px = prices.get(t.mint);
    if (!px) continue;
    t.marketPx = px; // used by the optional market-basis assumption
    if (t.qty <= 0 || t.valueUsd <= 0) continue;
    const implied = t.valueUsd / t.qty;
    if (implied <= px * 1.3 && implied >= px * 0.7) continue;

    if (now - t.ts < 7 * 86400) {
      // recent: today's spot is a fair stand-in for the trade-time price
      t.valueUsd = Math.round(t.qty * px * 100) / 100;
      t.priceCorrected = true;
      corrected++;
    } else {
      // old: spot says nothing about the historical price — drop rather than lie
      trades.splice(i, 1);
      ambiguousCount++;
    }
  }
  return { corrected, ambiguous: ambiguousCount };
}

/** Fetch one parsed transaction; null if a mirror doesn't index it. */
async function fetchTx(s, opts = {}) {
  try {
    return await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], opts);
  } catch (e) {
    if (e instanceof RpcError && e.code === -32020) return null;
    throw e;
  }
}

/** Net token balance changes for the wallet in one transaction. */
export function tokenDeltas(meta, owner) {
  const pre = new Map(meta.preTokenBalances?.map((b) => [key(b), b]) ?? []);
  const post = meta.postTokenBalances?.map((b) => [key(b), b]) ?? [];
  const out = [];

  for (const [k, pb] of post) {
    const before = pre.get(k);
    const was = num(before?.uiTokenAmount) ?? 0;
    const now = num(pb.uiTokenAmount) ?? 0;
    if (Math.abs(now - was) > 1e-9 && pb.owner === owner) {
      out.push({ mint: pb.mint, delta: now - was });
    }
  }
  // balances that existed before but vanished (account closed in this tx)
  for (const [k, pb] of pre) {
    if (post.some(([pk]) => pk === k)) continue;
    const was = num(pb.uiTokenAmount) ?? 0;
    if (Math.abs(was) > 1e-9 && pb.owner === owner) out.push({ mint: pb.mint, delta: -was });
  }
  return out;

  function key(b) {
    // tokenBalances carry accountIndex (not a token account address) — two
    // accounts of the same mint must stay distinct until we net per mint
    return `${b.mint}:${b.accountIndex ?? b.tokenAccount ?? b.address ?? ""}`;
  }
  function num(a) {
    const s = a?.uiAmountString;
    if (s != null) {
      const v = Number(s);
      if (Number.isFinite(v)) return v;
    }
    return a?.uiAmount ?? null;
  }
}

/**
 * Pair equity deltas with cash deltas inside one tx.
 * Exported for fixture regression tests.
 * @returns {Promise<void>}
 */
export async function pairTrades(deltas, ctx, trades, transfers) {
  // net movements per mint first — dust in a second token account of the same
  // mint must not become a second "trade"; fully-cancelled mints drop out
  const net = new Map();
  for (const d of deltas) {
    const v = (net.get(d.mint) ?? 0) + d.delta;
    if (Math.abs(v) > 1e-9) net.set(d.mint, v);
    else net.delete(d.mint);
  }

  const metas = new Map();
  for (const mint of net.keys()) {
    if (metas.has(mint)) continue;
    try {
      metas.set(mint, await lookupToken(mint));
    } catch {
      metas.set(mint, null); // unclassifiable right now: non-stock, other legs still trade
    }
  }

  const cash = [...net.entries()]
    .filter(([mint]) => STABLES.has(mint) || mint === WSOL)
    .map(([mint, delta]) => ({ mint, delta }));
  const equity = [...net.entries()]
    .filter(([mint]) => metas.get(mint)?.isStock)
    .map(([mint, delta]) => ({ mint, delta }));

  const needsSolPrice = cash.some((c) => c.mint === WSOL) || Math.abs(ctx.solDelta ?? 0) > 1e-9;
  const solPrice = needsSolPrice ? await solUsdOn(ctx.ts) : 1;
  if (needsSolPrice && !Number.isFinite(solPrice)) {
    // no price source available: a movement without a value, never a $1 guess
    for (const e of equity) transfers.push({ mint: e.mint, delta: e.delta, ...ctx });
    return;
  }
  const cashUsd = (c) => (c.mint === WSOL ? Math.abs(c.delta) * solPrice : Math.abs(c.delta));

  // a multi-stock bundle cannot be decomposed from deltas alone — no greedy
  // guessing which cash leg paid for which share: record all as movements
  if (equity.length > 1) {
    for (const e of equity) transfers.push({ mint: e.mint, delta: e.delta, ...ctx });
    return;
  }

  for (const e of equity) {
    // every opposite-sign cash leg of the same tx participates in the trade
    const legs = cash.filter((c) => Math.sign(c.delta) !== Math.sign(e.delta));
    if (!legs.length) {
      // most "missing" cash legs are wrapped SOL created and burned inside the
      // same transaction: the wallet's SOL balance shows the money moving
      const sol = ctx.solDelta ?? 0;
      if (sol !== 0 && Math.sign(sol) !== Math.sign(e.delta)) {
        trades.push({
          side: e.delta > 0 ? "buy" : "sell",
          mint: e.mint,
          qty: Math.abs(e.delta),
          valueUsd: (Math.abs(sol) / 1e9) * solPrice,
          ts: ctx.ts,
          signature: ctx.signature,
        });
        continue;
      }
      // no cash involved: a withdrawal/deposit moves basis with the tokens.
      // Outgoing stock consumes open lots (no P&L); incoming creates none.
      trades.push({
        side: e.delta < 0 ? "out" : "in",
        mint: e.mint,
        qty: Math.abs(e.delta),
        valueUsd: 0,
        ts: ctx.ts,
        signature: ctx.signature,
      });
      continue;
    }
    const valueUsd = legs.reduce((s, c) => s + cashUsd(c), 0);
    for (const c of legs) cash.splice(cash.indexOf(c), 1); // consumed
    trades.push({
      side: e.delta > 0 ? "buy" : "sell",
      mint: e.mint,
      qty: Math.abs(e.delta),
      valueUsd,
      ts: ctx.ts,
      signature: ctx.signature,
    });
  }
}

/** Net SOL change of the wallet's own system account, in lamports. */
export function walletSolDelta(tx, address) {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const i = keys.findIndex((k) => k.pubkey === address);
  if (i === -1) return 0;
  let delta = (tx.meta.postBalances?.[i] ?? 0) - (tx.meta.preBalances?.[i] ?? 0);
  // the fee payer pays network fees from the same balance — that is not part
  // of any trade's cash leg
  if (i === 0 && tx.meta.fee) delta += tx.meta.fee;
  return delta;
}
