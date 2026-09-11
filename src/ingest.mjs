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

  return { trades, transfers, seen: scanned };
}

const TX_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 5);

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
function tokenDeltas(meta, owner) {
  const pre = new Map(meta.preTokenBalances?.map((b) => [key(b), b]) ?? []);
  const post = meta.postTokenBalances?.map((b) => [key(b), b]) ?? [];
  const out = [];

  for (const [k, pb] of post) {
    const before = pre.get(k);
    const was = num(before?.uiTokenAmount) ?? 0;
    const now = num(pb.uiTokenAmount) ?? 0;
    if (Math.abs(now - was) > 1e-9 && (!pb.owner || pb.owner === owner)) {
      out.push({ mint: pb.mint, delta: now - was });
    }
  }
  // balances that existed before but vanished (account closed in this tx)
  for (const [k, pb] of pre) {
    if (post.some(([pk]) => pk === k)) continue;
    const was = num(pb.uiTokenAmount) ?? 0;
    if (Math.abs(was) > 1e-9 && (!pb.owner || pb.owner === owner)) out.push({ mint: pb.mint, delta: -was });
  }
  return out;

  function key(b) {
    return `${b.mint}:${b.tokenAccount ?? b.address ?? ""}`;
  }
  function num(a) {
    return a?.uiAmount ?? null;
  }
}

/**
 * Pair equity deltas with cash deltas inside one tx.
 * @returns {Promise<void>}
 */
async function pairTrades(deltas, ctx, trades, transfers) {
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
    try {
      metas.set(mint, await lookupToken(mint));
    } catch {
      return; // classification unavailable: skip the tx rather than misreport it
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
  const cashUsd = (c) => (c.mint === WSOL ? Math.abs(c.delta) * solPrice : Math.abs(c.delta));

  for (const e of equity) {
    // only an opposite-sign cash leg pays for a trade; an equity movement
    // without one is a transfer (deposit, withdrawal, gift) — never a sale
    const idx = cash.findIndex((c) => Math.sign(c.delta) !== Math.sign(e.delta));
    if (idx === -1) {
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
      transfers.push({ mint: e.mint, delta: e.delta, ...ctx });
      continue;
    }
    const counter = cash[idx];
    cash.splice(idx, 1); // one cash leg pays for exactly one trade
    trades.push({
      side: e.delta > 0 ? "buy" : "sell",
      mint: e.mint,
      qty: Math.abs(e.delta),
      valueUsd: cashUsd(counter),
      ts: ctx.ts,
      signature: ctx.signature,
    });
  }
}

/** Net SOL change of the wallet's own system account, in lamports. */
function walletSolDelta(tx, address) {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const i = keys.findIndex((k) => k.pubkey === address);
  if (i === -1) return 0;
  return (tx.meta.postBalances?.[i] ?? 0) - (tx.meta.preBalances?.[i] ?? 0);
}
