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
  const signal = opts.signal;
  const sigs = [];
  for await (const s of allSignatures(address, opts)) {
    // failed txs changed nothing; a tx without blockTime cannot be placed on
    // the FIFO timeline (ts=0 would sort it before every real trade and dump
    // its sells into unknown-basis) — skipping leaves an honest coverage hole
    // that reconciliation with live balances already compensates for
    if (s.err || s.blockTime == null) continue;
    sigs.push(s);
    opts.onWalk?.(sigs.length);
    if (sigs.length >= (opts.maxScanTx ?? 1500)) break; // no point walking past the fetch budget
  }
  if (signal?.aborted) throw new Error("scan aborted");
  // allSignatures yields newest-first; scan that direction and stop on budget
  /** @type {Trade[]} */
  const trades = [];
  const transfers = [];
  const stats = { classifyFailed: 0 }; // mints we could not classify (network/API), not "not a stock"
  const started = Date.now();
  const maxTx = opts.maxScanTx ?? 1500;
  const target = opts.targetStockTrades ?? 30;
  const timeBudgetMs = (opts.timeBudgetS ?? 100) * 1000;
  let scanned = 0;

  for (let i = 0; i < sigs.length; i += TX_CONCURRENCY) {
    // the trade target counts buys and sells only: transfers and custody
    // movements must not cut the scan short on transfer-heavy wallets
    const bsCount = trades.reduce((s, t) => s + (t.side === "buy" || t.side === "sell" ? 1 : 0), 0);
    if (signal?.aborted) throw new Error("scan aborted");
    if (scanned >= maxTx || bsCount >= target || Date.now() - started > timeBudgetMs) break;

    const chunk = sigs.slice(i, i + TX_CONCURRENCY);
    // no .catch here: a sustained RPC failure must reject the scan, not skip txs
    const txs = await Promise.all(chunk.map((s) => fetchTx(s, opts)));

    for (let j = 0; j < chunk.length; j++) {
      const tx = txs[j];
      const s = chunk[j];
      scanned++;
      if (!tx?.meta) continue;
      const deltas = tokenDeltas(tx.meta, address);
      if (!deltas.length) continue;
      const ctx = {
        ts: s.blockTime ?? 0,
        slot: s.slot,
        signature: s.signature,
        signal, // reaches lookupToken: an aborted scan stops paying for metadata too
        solDelta: walletSolDelta(tx, address), // lamports; catches WSOL legs that open+close in one tx
        closedAta: closedTokenAccounts(tx.meta, address), // rent refunds ride the same delta
      };
      await pairTrades(deltas, ctx, trades, transfers, stats);
    }
    // the progress counter means the same as the stop target: buys/sells only —
    // custody movements must not read as "stock trades found"
    opts.onProgress?.({ scanned, trades: trades.filter((t) => t.side === "buy" || t.side === "sell").length, budget: maxTx });
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
    classifyFailed: stats.classifyFailed,
    coverage: { fromTs: lastFetched?.blockTime ?? null, toTs: sigs[0]?.blockTime ?? null, scanned },
  };
}

// chunks feed the single serialized RPC queue — this knob only sets how many
// fetches are queued per round, it does not bypass the global pacing.
// Environment numbers pass through a finite-or-default gate: a typo like
// "5," or "1O00" parses to NaN (silently switching every budget check off),
// and an empty string parses to 0 (instantly ending the scan) — both must
// fall back to the default instead of quietly changing behavior.
export const envInt = (v, dflt) => {
  if (v == null || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const TX_CONCURRENCY = envInt(process.env.INGEST_CONCURRENCY, 5);

/**
 * Aggregator routes make cash-leg pairing ambiguous. Trades whose implied
 * price is far off market are repriced at market when recent; older ones are
 * converted to no-P&L movements — a current spot price must not rewrite
 * month-old history, but the shares still moved and the inventory must show it.
 * Pure: prices and clock injected, exported for tests.
 */
export function applySanityGate(trades, prices, now) {
  let corrected = 0;
  let ambiguous = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    const px = prices.get(t.mint);
    if (!px) continue;
    t.marketPx = px; // used by the optional market-basis assumption
    t.marketPxAt = now; // and the assumption is only valid while the quote is fresh for the trade
    if (t.qty <= 0 || t.valueUsd <= 0) continue;
    const implied = t.valueUsd / t.qty;
    // a weekly price move can push a FAIR implied price well outside ±30%;
    // repricing such a trade at today's spot would rewrite cash the wallet
    // actually paid. Only a price the market cannot explain (>=2x off) is
    // treated as aggregator garbage and repriced/converted to a movement.
    if (implied <= px * 2 && implied >= px * 0.5) continue;

    if (now - t.ts < 7 * 86400) {
      // recent: today's spot is a fair stand-in for the trade-time price
      t.valueUsd = Math.round(t.qty * px * 100) / 100;
      t.priceCorrected = true;
      corrected++;
    } else {
      // old: spot says nothing about the historical price — book the movement
      // without P&L instead of pretending it never happened (phantom lots)
      t.side = t.side === "sell" ? "out" : "in";
      t.valueUsd = 0;
      delete t.priceCorrected;
      ambiguous++;
    }
  }
  return { corrected, ambiguous };
}

async function priceSanityGate(trades) {
  if (!trades.length) return { corrected: 0, ambiguous: 0 };
  // offline test hook: skip live market lookup entirely
  if (process.env.STOCKBASIS_NO_MARKET === "1") return { corrected: 0, ambiguous: 0 };
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
  return applySanityGate(trades, prices, Date.now() / 1000);
}

/** Fetch one parsed transaction; null ONLY when every mirror truly lacks it. */
async function fetchTx(s, opts = {}) {
  // a genuinely missing tx (-32020 on all mirrors) is a hole in the data and
  // skips quietly; any SUSTAINED rpc failure instead fails the whole scan —
  // a silently incomplete report is worse than an honest "try again"
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], opts);
    } catch (e) {
      if (e instanceof RpcError && e.code === -32020) return null;
      if (attempt >= 1) throw e;
    }
  }
}

// The dust epsilon is INCLUSIVE and shared by every layer that filters on it
// (tokenDeltas, the pairing net, the basis queues): mint decimals is a u8, so
// mints finer than 9 decimals exist — a 12-decimals mint's smallest unit is
// exactly 1e-12 and must survive every filter as a real movement.
export const DUST_EPS = 1e-12;

/** Net token balance changes for the wallet in one transaction. */
export function tokenDeltas(meta, owner) {
  const pre = new Map(meta.preTokenBalances?.map((b) => [key(b), b]) ?? []);
  const post = meta.postTokenBalances?.map((b) => [key(b), b]) ?? [];
  const out = [];

  for (const [k, pb] of post) {
    const before = pre.get(k);
    const ownerChanged = before != null && before.owner !== pb.owner;
    // an authority flip moves the WHOLE account between owners: diffing the
    // flip-in against the previous owner's balance would understate the
    // deposit, and the flip-out would vanish entirely (the account key still
    // exists post-tx, so neither loop below would see it)
    if (pb.owner === owner) {
      const now = num(pb.uiTokenAmount);
      // an unreadable post balance (hostile uiAmount like 1e999) must not
      // coerce into an Infinity/phantom delta — the honest answer is "this
      // tx's balance change is unknown", same skip a missing blockTime gets
      if (now == null) continue;
      const wasRaw = ownerChanged ? 0 : num(before?.uiTokenAmount);
      // the account was ours before AND after with an unreadable pre value:
      // coerced to 0 it would invent a phantom full deposit, so skip instead
      if (!ownerChanged && before != null && wasRaw == null) continue;
      const was = wasRaw ?? 0; // absent or previously-not-ours: 0 is the truth
      if (Math.abs(now - was) >= DUST_EPS) out.push({ mint: pb.mint, delta: now - was });
    } else if (before?.owner === owner) {
      // the account left our ownership mid-tx: the full prior balance is a
      // disposal, whatever the (possibly unchanged) post balance says — but
      // an unreadable prior balance is a hole, not a zero disposal
      const wasOurs = num(before.uiTokenAmount);
      if (wasOurs != null && Math.abs(wasOurs) >= DUST_EPS) out.push({ mint: before.mint, delta: -wasOurs });
    }
  }
  // balances that existed before but vanished (account closed in this tx)
  for (const [k, pb] of pre) {
    if (post.some(([pk]) => pk === k)) continue;
    const was = num(pb.uiTokenAmount);
    if (was != null && Math.abs(was) >= DUST_EPS && pb.owner === owner) out.push({ mint: pb.mint, delta: -was });
  }
  return out;

  function key(b) {
    // tokenBalances carry accountIndex (not a token account address) — two
    // accounts of the same mint must stay distinct until we net per mint
    return `${b.mint}:${b.accountIndex ?? b.tokenAccount ?? b.address ?? ""}`;
  }
  function num(a) {
    // balances are attacker-adjacent data: uiAmount can be hostile garbage
    // ("1e999" parses to Infinity) — only a finite number counts as read,
    // null means "this balance could not be read" and callers must skip,
    // never coerce the hole into a 0 balance (that invents phantom trades)
    const s = a?.uiAmountString;
    if (s != null) {
      const v = Number(s);
      if (Number.isFinite(v)) return v;
    }
    const v = a?.uiAmount;
    return Number.isFinite(v) ? v : null;
  }
}

/**
 * Pair equity deltas with cash deltas inside one tx.
 * Exported for fixture regression tests.
 * @returns {Promise<void>}
 */
const MIN_SOL_LEG = envInt(process.env.MIN_SOL_LEG, 0.01); // SOL: below this a delta is rent/fee dust, not a cash leg
// Closing a token account refunds its rent-exempt deposit (~0.0021 SOL at
// the historical maximum). Five closed ATAs clear the 0.01 SOL leg floor, so
// the raw solDelta would book refund dust as sale proceeds. The constant is
// an upper bound of the refund: clipping by it can only ever trim rent,
// never real cash (at most a cent of true tail at SOL ~$200).
const RENT_PER_CLOSED_ATA = 2_100_000; // lamports

/** Token accounts of `owner` present before the tx and gone after (closed). */
function closedTokenAccounts(meta, owner) {
  const key = (b) => `${b.mint}:${b.accountIndex ?? b.tokenAccount ?? b.address ?? ""}`;
  const post = new Set((meta.postTokenBalances ?? []).map(key));
  let n = 0;
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner === owner && !post.has(key(b))) n++;
  }
  return n;
}

export async function pairTrades(deltas, ctx, trades, transfers, stats = { classifyFailed: 0 }) {
  // net movements per mint first — dust in a second token account of the same
  // mint must not become a second "trade"; fully-cancelled mints drop out.
  // The epsilon is the shared inclusive DUST_EPS: the smallest unit of a
  // 12-decimals mint (exactly 1e-12) is a real movement, not dust.
  const net = new Map();
  for (const d of deltas) {
    const v = (net.get(d.mint) ?? 0) + d.delta;
    if (Math.abs(v) >= DUST_EPS) net.set(d.mint, v);
    else net.delete(d.mint);
  }

  const metas = new Map();
  for (const mint of net.keys()) {
    if (metas.has(mint)) continue;
    try {
      metas.set(mint, await lookupToken(mint, { signal: ctx.signal }));
    } catch {
      metas.set(mint, null); // unclassifiable right now: non-stock, other legs still trade
      stats.classifyFailed++; // surfaced by the caller — silence here would fake "no trades found"
    }
  }

  let cash = [...net.entries()]
    .filter(([mint]) => STABLES.has(mint) || mint === WSOL)
    .map(([mint, delta]) => ({ mint, delta }));
  let equity = [...net.entries()]
    .filter(([mint]) => metas.get(mint)?.isStock)
    .map(([mint, delta]) => ({ mint, delta }));

  // a route that sweeps dust of a second stock past the real trade must not
  // demote the whole swap to an unattributable bundle: immaterial equity legs
  // (nano dust, or a rounding-error share of the main leg) become disclosed
  // movements while the material leg keeps its cash pairing and its P&L
  if (equity.length > 1) {
    const prim = equity.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
    const dust = equity.filter((e) => e !== prim && (Math.abs(e.delta) < 1e-6 || Math.abs(e.delta) < 0.01 * Math.abs(prim.delta)));
    if (dust.length === equity.length - 1) {
      for (const d of dust) {
        transfers.push({ mint: d.mint, delta: d.delta, ...ctx });
        trades.push({ side: d.delta < 0 ? "out" : "in", mint: d.mint, qty: Math.abs(d.delta), valueUsd: 0, ts: ctx.ts, slot: ctx.slot, signature: ctx.signature, aggregated: true });
      }
      equity = [prim];
    }
  }

  // a multi-stock bundle cannot be decomposed from deltas alone — no greedy
  // guessing which cash leg paid for which share. Record the movements without
  // P&L: outgoing shares consume open lots, incoming create unknown-basis
  // inventory. Vanishing them would leave phantom open positions. The
  // aggregated flag marks real disposals whose proceeds cannot be attributed:
  // the report must disclose them, not drop them silently.
  if (equity.length > 1) {
    for (const e of equity) {
      transfers.push({ mint: e.mint, delta: e.delta, ...ctx });
      trades.push({ side: e.delta < 0 ? "out" : "in", mint: e.mint, qty: Math.abs(e.delta), valueUsd: 0, ts: ctx.ts, slot: ctx.slot, signature: ctx.signature, aggregated: true });
    }
    // the cash side of the bundle is real money movement too: dropping it
    // would leave the ledger blind to where the dollars went
    for (const c of cash) transfers.push({ mint: c.mint, delta: c.delta, ...ctx });
    return;
  }

  // SOL price is fetched lazily — only when a SOL-denominated leg is real.
  // Routine rent/fee SOL deltas must not depend on price-API availability.
  let solPrice = null;
  const ensureSolPrice = async () => {
    if (solPrice == null) solPrice = await solUsdOn(ctx.ts);
    return solPrice;
  };

  // The native tail is priced only from SOL the wallet economically paid for
  // this stock. Two same-tx facts disprove that and must degenerate the tail:
  // (a) an opposite-sign WSOL delta is the wrapped side of the same money
  // (wrap: −SOL +WSOL) — netting it out stops a custody deposit that wraps
  // SOL in passing from booking a phantom purchase with invented basis;
  // (b) token deltas we could not classify (an unrelated swap leg) mean the
  // SOL flow cannot be attributed to this equity — pricing the tail would
  // launder that other leg's payment into our basis.
  const wsolNet = net.get(WSOL) ?? 0;
  const hasUnknownLegs = [...net.keys()].some((m) => m !== WSOL && !STABLES.has(m) && !metas.get(m)?.isStock);
  const econSolTail = (equityDelta) => {
    const sol = ctx.solDelta ?? 0;
    if (sol === 0 || Math.sign(sol) === Math.sign(equityDelta)) return 0;
    if (hasUnknownLegs) return 0;
    let eff = Math.abs(sol);
    if (wsolNet !== 0 && Math.sign(wsolNet) === -Math.sign(sol)) {
      eff = Math.max(0, eff - Math.abs(wsolNet) * 1e9);
    }
    return Math.max(0, eff - (ctx.closedAta ?? 0) * RENT_PER_CLOSED_ATA);
  };

  for (const e of equity) {
    // every opposite-sign cash leg of the same tx participates in the trade
    const legs = cash.filter((c) => Math.sign(c.delta) !== Math.sign(e.delta));
    if (legs.some((c) => c.mint === WSOL) && solPrice == null) {
      solPrice = await ensureSolPrice();
    }
    if (!legs.length) {
      // most "missing" cash legs are wrapped SOL created and burned inside the
      // same transaction: the wallet's SOL balance shows the money moving.
      // Rent reclaims and fee dust sit below the leg floor — a gift plus a
      // closed empty ATA must not book a micro-"sale"; rent refunded for
      // closed accounts is clipped off before the floor is applied. A wrap
      // netted to zero (econSolTail) or unattributable SOL leaves a movement.
      const netSol = econSolTail(e.delta);
      if (netSol >= MIN_SOL_LEG * 1e9) {
        const price = await ensureSolPrice();
        if (Number.isFinite(price)) {
          trades.push({
            side: e.delta > 0 ? "buy" : "sell",
            mint: e.mint,
            qty: Math.abs(e.delta),
            valueUsd: (netSol / 1e9) * price,
            ts: ctx.ts,
            slot: ctx.slot,
            signature: ctx.signature,
          });
          continue;
        }
      }
      // no cash involved: a withdrawal/deposit moves basis with the tokens.
      // Outgoing stock consumes open lots (no P&L); incoming creates none.
      trades.push({
        side: e.delta < 0 ? "out" : "in",
        mint: e.mint,
        qty: Math.abs(e.delta),
        valueUsd: 0,
        ts: ctx.ts,
        slot: ctx.slot,
        signature: ctx.signature,
      });
      continue;
    }
    // stablecoin legs are self-priced; WSOL legs need the SOL price
    let valueUsd = 0;
    const unpriced = []; // cash legs with no price source right now
    for (const c of legs) {
      if (c.mint === WSOL) {
        if (Number.isFinite(solPrice)) valueUsd += Math.abs(c.delta) * solPrice;
        else unpriced.push(c);
      } else valueUsd += Math.abs(c.delta);
    }
    // routes can split proceeds between a stable tail and native SOL: a
    // temporary WSOL account unwrapped inside the tx never shows up in the
    // token balances, only in solDelta — that native side is cash of the SAME
    // trade, priced on top of the stable legs, never dropped. Rent refunded
    // for closed token accounts rides the same delta and is not proceeds;
    // a wrapped or unattributable SOL flow (econSolTail) prices nothing.
    const tail = econSolTail(e.delta);
    let solTail = 0; // lamports of the native tail that are real cash, not rent
    if (tail >= MIN_SOL_LEG * 1e9) solTail = tail;
    let tailUnpriced = false;
    if (solTail > 0) {
      const price = await ensureSolPrice();
      if (Number.isFinite(price)) valueUsd += (solTail / 1e9) * price;
      else tailUnpriced = true;
    }
    if (valueUsd > 0) {
      // the priced part books the trade even when the SOL side has no price
      // source: known money (the stable legs) must never be thrown away with
      // the unknown. The unpriced tail still moved the wallet, so it lands in
      // the ledger as a disclosed movement instead of vanishing — and the
      // trade carries partialCash so the report can say the P&L is understated
      // instead of letting a silently halved sale pass as fully valued
      const cashIncomplete = unpriced.length > 0 || tailUnpriced;
      for (const c of unpriced) transfers.push({ mint: c.mint, delta: c.delta, ...ctx });
      if (tailUnpriced) transfers.push({ mint: WSOL, delta: solTail / 1e9, ...ctx });
      for (const c of legs) cash.splice(cash.indexOf(c), 1); // consumed either way
      trades.push({
        side: e.delta > 0 ? "buy" : "sell",
        mint: e.mint,
        qty: Math.abs(e.delta),
        valueUsd,
        ts: ctx.ts,
        slot: ctx.slot,
        signature: ctx.signature,
        ...(cashIncomplete ? { partialCash: true } : {}),
      });
      continue;
    }
    // nothing priced at all: a movement without a value, never a guess —
    // and never a disappearance: the shares still left/arrived
    for (const c of legs) {
      cash.splice(cash.indexOf(c), 1);
      transfers.push({ mint: c.mint, delta: c.delta, ...ctx });
    }
    transfers.push({ mint: e.mint, delta: e.delta, ...ctx });
    trades.push({ side: e.delta < 0 ? "out" : "in", mint: e.mint, qty: Math.abs(e.delta), valueUsd: 0, ts: ctx.ts, slot: ctx.slot, signature: ctx.signature });
    continue;
  }
  // cash that moved WITH the trade's own direction (a same-sign hop, e.g. a
  // USDT leg routed through the wallet mid-route) never paired with any
  // equity leg: the trade priced cleanly without it, but the money still
  // moved — the ledger must not lose the record
  for (const c of cash) transfers.push({ mint: c.mint, delta: c.delta, ...ctx });
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
