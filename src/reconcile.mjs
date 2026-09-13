// Public RPC mirrors silently lack older transactions, so a reconstructed
// inventory can drift from reality — a report may claim open lots the wallet
// no longer holds (phantom positions). The chain's CURRENT balances are always
// readable in one call: true open positions up against them. Adjustments are
// booked as basis-less movements — disposals we could not see get no invented
// proceeds, deposits we could not see get no invented basis.

import { rpc } from "./rpc.mjs";
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

/**
 * Live on-chain balances for the given mints. One filtered call per mint —
 * the unfiltered "all accounts" answer is too large for public RPC on active
 * wallets, while per-mint queries are small and reliable.
 * @returns {Promise<Map<string, number>>} mint -> uiAmount
 */
export async function walletBalances(address, mints) {
  const balances = new Map();
  for (const mint of mints) {
    // strict 3-param form: some providers (Helius) reject a filter object that
    // mixes a filter key with config keys like encoding
    const res = await rpc("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }]).catch(() => null);
    let q = 0;
    for (const a of res?.value ?? []) q += a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    balances.set(mint, q);
  }
  return balances;
}

/**
 * Build the report, then true up open positions against the chain and rebuild.
 * @returns {Promise<{report: object, reconciled: number}>}
 */
export async function buildReconciledReport(address, trades) {
  const report = await buildReport(trades);
  let balances;
  try {
    balances = await walletBalances(address, report.rows.map((r) => r.mint));
  } catch {
    return { report, reconciled: 0 }; // chain unreadable right now — the scan result stands
  }
  const adjustments = diffAdjustments(report.rows, balances);
  if (!adjustments.length) return { report, reconciled: 0 };

  const now = Math.floor(Date.now() / 1000);
  const synthetic = adjustments.map((a) => ({
    side: a.diff < 0 ? "out" : "in", // phantom lots leave the books; unseen deposits arrive basis-less
    mint: a.mint,
    qty: Math.abs(a.diff),
    valueUsd: 0,
    ts: now,
    signature: "chain-reconcile",
  }));
  const rebuilt = await buildReport([...trades, ...synthetic]);
  return { report: rebuilt, reconciled: adjustments.length };
}
