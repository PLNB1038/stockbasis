// Ground-truth verification: for wallets with scanned positions, the report's
// open qty per token must equal the REAL on-chain token balance right now.
// Mismatches mean reconstruction bugs (missed buys/sells/transfers).
// A balance read that FAILS is never read as a zero balance: the row is
// reported as unreadable and the address verdict becomes INCOMPLETE (the same
// rule reconcile.mjs enforces on production reports — a transient RPC hiccup
// must not dress up as a "tool holds phantom" finding).
// An EMPTY account list is the same trap in a subtler shape: it passes the
// array guard and sums to zero, but it is ONE mirror's word — a mirror that
// simply does not index token accounts would turn every real position into a
// false phantom. The reconcile.mjs rule applies here too: an empty answer is
// cross-checked against a mirror that did NOT just serve it, and with no other
// mirror to ask it is skipped as unreadable ("not compared"), never zeroed.
//
//   node scripts/verify-open-positions.mjs <addr1> <addr2> ...

import { rpc, rpcEndpoints } from "../src/rpc.mjs";
import { ingestWallet } from "../src/ingest.mjs";
import { buildReport } from "../src/report.mjs";

// parse a token amount the way reconcile.mjs does: the exact string form
// first, the float form as fallback — and ONLY finite numbers. A null or
// garbage uiAmount must fail the whole read, never silently count as zero.
const amountOf = (a) => {
  const s = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
  if (s != null) {
    const v = Number(s);
    if (Number.isFinite(v)) return v;
  }
  const v = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
  return Number.isFinite(v) ? v : null;
};

for (const address of process.argv.slice(2)) {
  // per-address try/catch (same shape as pick-featured): one failed scan must
  // cost its own verdict line, not the remaining addresses on the list
  try {
    const { trades } = await ingestWallet(address, { maxScanTx: 8000, targetStockTrades: 300, timeBudgetS: 300 });
    const report = await buildReport(trades);

    let checked = 0;
    let mismatches = [];
    let unreadable = []; // balance reads that failed — never compared against a zero
    for (const row of report.rows) {
      let res, readErr, answeredBy; // the mirror that served this answer, for exclusion below
      try {
        res = await rpc("getTokenAccountsByOwner", [
          address,
          { mint: row.mint },
          { encoding: "jsonParsed" },
        ], { onEndpoint: (u) => { answeredBy = u; } });
      } catch (e) { readErr = e; }
      if (readErr || !Array.isArray(res?.value)) {
        // a failed read is NOT a zero balance: comparing it against the claimed
        // qty would turn a transient RPC hiccup into a false "tool holds
        // phantom" verdict and train the operator to ignore MISMATCH lines
        const why = readErr ? String(readErr?.message ?? readErr).slice(0, 80) : "malformed answer (no account list)";
        unreadable.push(`${row.symbol}: balance read failed (${why}) — skipped, not compared`);
        continue;
      }
      let accounts = res.value;
      if (!accounts.length) {
        // an EMPTY list is one mirror's word, not a zero balance: a mirror
        // that does not index token accounts answers 200-OK with [] and, read
        // as a zero, would turn every real position into a false "tool holds
        // phantom". Zeroing is destructive, so demand agreement from mirrors
        // OTHER than the one that just answered (the global rotator index can
        // drift between the two calls — only the answering mirror itself is a
        // safe exclusion; the same rule reconcile.mjs enforces). With no other
        // mirror to ask, the row is skipped as unreadable instead of compared
        const { current, others } = rpcEndpoints();
        const verify = (answeredBy ? [current, ...others] : others).filter((u) => u !== answeredBy);
        if (!verify.length) {
          unreadable.push(`${row.symbol}: empty answer from one mirror — not compared (no other mirror to cross-check)`);
          continue;
        }
        let confirm, confirmErr;
        try {
          confirm = await rpc("getTokenAccountsByOwner", [
            address,
            { mint: row.mint },
            { encoding: "jsonParsed" },
          ], { rpcUrl: verify.join(",") });
        } catch (e) { confirmErr = e; }
        // the confirming answer must be a real account list: any other 200-OK
        // shape is NOT agreement with "zero", it is a second failed read
        if (confirmErr || !Array.isArray(confirm?.value)) {
          const why = confirmErr ? String(confirmErr?.message ?? confirmErr).slice(0, 80) : "malformed answer (no account list)";
          unreadable.push(`${row.symbol}: empty answer from one mirror — not compared (cross-check failed: ${why})`);
          continue;
        }
        // the cross-checked list replaces the first one: an empty list HERE is
        // a two-mirror zero — a fact, and safe to compare like any other read
        accounts = confirm.value;
      }
      let onChain = 0;
      let ok = true;
      for (const a of accounts) {
        const v = amountOf(a);
        if (v == null) { ok = false; break; }
        onChain += v;
      }
      if (!ok) {
        unreadable.push(`${row.symbol}: balance read failed (unreadable token amount) — skipped, not compared`);
        continue;
      }

      const claimed = (row.openQty ?? 0) + (row.openUnknownQty ?? 0);
      if (claimed < 1e-9 && onChain < 1e-9) continue;
      checked++;
      const diff = Math.abs(onChain - claimed);
      const tol = Math.max(1e-6, onChain * 0.01); // 1% tolerance for races between scan and now
      if (diff > tol) {
        const dir = claimed > onChain ? "tool holds phantom (missed transfer-out)" : "chain holds more (custody transfer-in)";
        mismatches.push(`${row.symbol}: tool ${claimed.toFixed(6)} vs chain ${onChain.toFixed(6)} — ${dir}`);
      }
    }

    const verdict = mismatches.length ? "MISMATCH" : unreadable.length ? "INCOMPLETE" : "OK";
    console.log(`${address.slice(0, 8)}… | rows ${report.rows.length} | open positions checked: ${checked} | unreadable reads: ${unreadable.length} | ${verdict}`);
    for (const m of mismatches) console.log(`   ${m}`);
    for (const m of unreadable) console.log(`   ${m}`);
  } catch (e) {
    console.log(`${String(address).slice(0, 8)}… | ERROR ${String(e?.message ?? e).slice(0, 60)}`);
  }
}
