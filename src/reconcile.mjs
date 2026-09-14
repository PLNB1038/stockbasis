// Public RPC mirrors silently lack older transactions, so a reconstructed
// inventory can drift from reality — a report may claim open lots the wallet
// no longer holds (phantom positions). The chain's CURRENT balances are always
// readable in one call: true open positions up against them. Adjustments are
// booked as basis-less movements — disposals we could not see get no invented
// proceeds, deposits we could not see get no invented basis.

import { rpc, rpcEndpoints } from "./rpc.mjs";
import { buildReport } from "./report.mjs";

/**
 * Pure diff: report rows vs a mint->uiAmount balance map.
 * @returns {Array<{mint: string, diff: number}>} diff = chain − claimed (known + unknown)
 */
export function diffAdjustments(rows, balances) {
  const adj = [];
  for (const row of rows) {
    if (!balances.has(row.mint)) continue;
    const onChain = balances.get(row.mint) ?? 0;
    const claimed = (row.openQty ?? 0) + (row.openUnknownQty ?? 0);
    const diff = onChain - claimed;
    // drift tolerance for in-flight activity between scan and balance read:
    // 1% relative, capped at half a unit so large positions don't get a
    // whale-sized silent allowance
    if (Math.abs(diff) <= Math.max(1e-6, Math.min(onChain * 0.01, 0.5))) continue;
    adj.push({ mint: row.mint, diff });
  }
  return adj;
}

/** Live on-chain balances for the given mints. One filtered call per mint —
 * the unfiltered "all accounts" answer is too large for public RPC on active
 * wallets, while per-mint queries are small and reliable.
 * An empty 200-OK answer is confirmed on a mirror that did not serve it
 * before it is allowed to zero out a position (same rule the -32020 path
 * already follows: one mirror's hole is not a chain fact).
 * @returns {Promise<{balances: Map<string, number>, failed: number}>}
 */
async function walletBalances(address, mints, opts = {}) {
  const balances = new Map();
  let failed = 0;
  for (const mint of mints) {
    // strict 3-param form: some providers reject a filter object that
    // mixes a filter key with config keys like encoding
    // a failed balance read must SKIP the mint: recording a zero would wipe
    // real open positions from the report on a transient RPC hiccup
    const res = await rpc("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }], opts).catch(() => null);
    if (!res) { failed++; continue; }
    if (!res.value?.length) {
      // empty answer: maybe the wallet truly sold out — or this mirror just
      // does not index token accounts. Zeroing positions is destructive, so
      // demand a second, independent mirror's agreement first
      const { others } = rpcEndpoints(opts);
      if (others.length) {
        const confirm = await rpc("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }], { ...opts, rpcUrl: others.join(",") }).catch(() => null);
        if (!confirm) { failed++; continue; } // cannot verify: leave the scan result standing
        let q = 0;
        for (const a of confirm.value ?? []) q += a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        balances.set(mint, q);
        continue;
      }
      // single-endpoint setup: nothing to cross-check with — trust the answer
    }
    let q = 0;
    for (const a of res?.value ?? []) q += a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    balances.set(mint, q);
  }
  return { balances, failed };
}

/**
 * Build the report, then true up open positions against the chain and rebuild.
 * @returns {Promise<{report: object, reconciled: number}>}
 */
export async function buildReconciledReport(address, trades, { now = () => Math.floor(Date.now() / 1000), rpcUrl } = {}) {
  const report = await buildReport(trades);
  let out;
  try {
    out = await walletBalances(address, report.rows.map((r) => r.mint), { rpcUrl });
  } catch {
    return { report, reconciled: 0, reconcileFailed: 0 }; // chain unreadable right now — the scan result stands
  }
  const adjustments = diffAdjustments(report.rows, out.balances);
  if (!adjustments.length) return { report, reconciled: 0, reconcileFailed: out.failed };

  const ts = typeof now === "function" ? now() : now;
  const synthetic = adjustments.map((a) => ({
    side: a.diff < 0 ? "out" : "in", // phantom lots leave the books; unseen deposits arrive basis-less
    mint: a.mint,
    qty: Math.abs(a.diff),
    valueUsd: 0,
    ts,
    slot: Number.MAX_SAFE_INTEGER, // after any real trade in the same second — never rewrite computed FIFO
    signature: "chain-reconcile",
  }));
  const rebuilt = await buildReport([...trades, ...synthetic]);
  return { report: rebuilt, reconciled: adjustments.length, reconcileFailed: out.failed };
}
