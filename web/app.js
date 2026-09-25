// StockBasis UI: scan a wallet, poll the job, render the report.

const $ = (id) => document.getElementById(id);
let lastResult = null;
let lastAddress = null;
let lastCloses = null;
let lastJob = null;

loadFeatured();
loadMarket();

async function loadFeatured() {
  try {
    const list = await (await fetch("/api/featured")).json();
    if (!list.length) return;
    $("featured").hidden = false;
    $("featured-list").innerHTML = list.map((f) =>
      `<button class="featured" data-addr="${esc(f.address)}"><b>${esc(f.label)}</b><span>${esc(f.address.slice(0, 4))}…${esc(f.address.slice(-4))}</span></button>`
    ).join("");
    for (const btn of document.querySelectorAll(".featured")) {
      btn.addEventListener("click", () => {
        $("address").value = btn.dataset.addr;
        $("scan").requestSubmit();
      });
    }
  } catch { /* featured list is optional decoration */ }
}

async function loadMarket() {
  try {
    const s = await (await fetch("/api/stats")).json();
    if (!s.trackedTokens) return;
    const vol = s.volume24hUsd ? ` · $${compact(s.volume24hUsd)} traded in 24h` : "";
    const tops = (s.top ?? []).slice(0, 4).map((t) => t.symbol).join(" · ");
    // the pool count comes from the live market feed; when the feed is down
    // it is zero, and claiming "pools tracked" from the static universe list
    // would print a number the market data cannot back
    const strip = s.tokensWithPools
      ? `${s.tokensWithPools} tokenized-equity pools tracked on Solana`
      : `${s.trackedTokens} tokenized equities tracked on Solana`;
    $("market").textContent = strip + vol;
    $("market").title = tops ? `Top pools: ${tops}` : "";
    $("market").hidden = false;
  } catch { /* strip is optional decoration */ }
}

let pollSeq = 0; // a newer submit invalidates an in-flight poll loop
let lastJobSeq = -1; // the pollSeq that produced lastJob/lastCloses
// a request that never settles (captive WiFi, roaming between access points)
// must read as a network failure, not freeze the progress bar forever — the
// override exists so tests can watch a hang resolve in milliseconds
const REQ_TIMEOUT_MS = globalThis.STOCKBASIS_REQ_TIMEOUT_MS ?? 10_000;

$("scan").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = $("address").value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return showError("That doesn't look like a Solana address.");

  const seq = ++pollSeq;
  lastAddress = address;
  $("go").disabled = true;
  show("progress"); hide("error"); hide("report"); hide("assume-opt");
  // stale numbers read as the new wallet's progress: until the first poll
  // answers, the line and bar must be empty, not the previous scan's tail
  $("progress-text").textContent = "";
  $("bar-fill").style.width = "0%";

  try {
    const res = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }), signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    // the status check comes before any parsing: a 502 HTML page from a proxy
    // answered res.json() with a raw "SyntaxError: Unexpected token '<'" — the
    // poll loop checks res.ok first, the submit must talk to the user the same way
    if (!res.ok) {
      let msg = `Server error — please try again (HTTP ${res.status})`;
      try { msg = (await res.json()).error ?? msg; } catch { /* the friendly line stays */ }
      throw new Error(msg);
    }
    let body;
    try { body = await res.json(); } catch { throw new Error("Server error — please try again."); }
    await poll(body.id, seq);
  } catch (err) {
    if (seq === pollSeq) showError(String(err.message ?? err));
  } finally {
    if (seq === pollSeq) $("go").disabled = false;
  }
});

async function poll(id, seq) {
  let flaky = 0; // tolerate brief network blips during a long scan
  for (;;) {
    if (seq !== pollSeq) return; // superseded by a newer scan
    let job;
    try {
      const res = await fetch(`/api/jobs/${id}`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      // HTTP-status failures are not network blips: a 404 means the job is
      // gone (server restarted, map pressure) and must surface its own
      // message instead of being retried into "Network error" half a minute
      // later — only a rejected fetch counts as flaky
      if (!res.ok) throw { hard: true, message: res.status === 404 ? "Server restarted — please run the scan again." : `HTTP ${res.status}` };
      job = await res.json();
      // a 200-OK body that is not a job record (a gateway or captive-portal
      // page that still parses as JSON) is a network blip, not progress:
      // swallowing it as "still running" would poll forever over
      // "Scanned undefined" progress and a NaN bar. Checking status alone is
      // not enough — {status:"running"} passes it and reproduces the same
      // hang — so the whole record shape must be coherent: progress numbers
      // while running, a result on done, an error message on error
      const shaped = typeof job?.status === "string" && (
        job.status === "done" ? job.result != null
        : job.status === "error" ? typeof job.error === "string"
        : Number.isFinite(job.progress) && Number.isFinite(job.trades)
      );
      if (!shaped) {
        if (++flaky > 5) throw { hard: true, message: "Unexpected server response — please scan again." };
        await new Promise((r) => setTimeout(r, 2000 * flaky));
        continue;
      }
      flaky = 0;
    } catch (err) {
      if (err?.hard) throw new Error(err.message);
      if (++flaky > 5) throw new Error("Network error — please scan again.");
      await new Promise((r) => setTimeout(r, 2000 * flaky));
      continue;
    }
    if (job.status === "done") {
      lastJob = job;
      lastJobSeq = seq;
      if (seq !== pollSeq) return; // a newer submit landed while this GET was in flight
      return render(job);
    }
    if (job.status === "error") throw new Error(job.error);
    $("progress-text").textContent = job.phase === "history"
      ? `Walking transaction history… ${job.progress} signatures`
      : `Scanned ${job.progress} transactions · ${job.trades} stock trades found`;
    $("bar-fill").style.width = `${Math.min(95, 8 + (job.trades / (job.target ?? 30)) * 87)}%`;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function render(job) {
  if (!job.result) return showError("Report unavailable — please run the scan again.");
  const { rows, totalRealized, tokens, unknownBasis } = job.result;
  lastResult = rows;

  const assume = $("assume").checked;
  const showAssumed = assume && rows.some((r) => (r.realizedAssumed ?? 0) !== 0);
  $("assume-opt").hidden = !(unknownBasis > 0);

  hide("progress");
  if (!rows.length) return showError("No tokenized-stock trades found in the scanned history. Try one of the wallets below the form.");

  const wins = rows.reduce((s, r) => s + r.wins, 0);
  const losses = rows.reduce((s, r) => s + r.losses, 0);
  const trades = rows.reduce((s, r) => s + r.trades, 0);

  const grand = showAssumed ? job.result.totalAssumed : totalRealized;
  const total = $("total");
  total.textContent = `${grand >= 0 ? "+" : "−"}${usd.format(Math.abs(grand))}`;
  total.className = `total-value ${grand >= 0 ? "pos" : "neg"}`;
  const cov = job.result.coverage;
  const covTxt = cov?.fromTs ? ` · history ${day(cov.fromTs)} → ${day(cov.toTs)} (${cov.scanned.toLocaleString("en-US")} txs)` : "";
  const disposals = job.result.disposals ?? job.result.closes ?? []; // unknown-basis disposals included
  $("total-sub").textContent = `${trades} stock trades · ${disposals.length} disposals · ${wins}W/${losses}L · ${tokens} stocks` + covTxt + (showAssumed ? " · market-basis assumption ON" : "");

  const note = $("basis-note");
  const notes = [];
  if (unknownBasis > 0 && !showAssumed) notes.push(`${unknownBasis} disposal${unknownBasis > 1 ? "s" : ""} with unknown cost basis (bought before the scanned history, or deposited from custody) listed with n/a basis and excluded from P&L — tick the box above to assume market price for recent disposals (a current quote says nothing about an old sale's basis).`);
  if ((job.result.priceCorrections ?? 0) > 0) notes.push(`${job.result.priceCorrections} recent trade${job.result.priceCorrections > 1 ? "s" : ""} valued at market price (cash leg ambiguous in an aggregated route).`);
  if ((job.result.partialCash ?? 0) > 0) {
    // the same counter covers ancient legs, where the SOL price is not
    // "unavailable at scan time" but permanently outside CoinGecko's 365-day
    // public window: there a rescan can never help, and the note must not
    // promise one — so the two causes get different wordings
    const pc = job.result.partialCash;
    if ((job.result.partialCashAncient ?? 0) > 0) {
      notes.push(`${pc} trade${pc > 1 ? "s" : ""} priced partially: the SOL price is outside the 365-day price window (cannot be recovered by rescanning), so proceeds and P&L are understated.`);
    } else {
      notes.push(`${pc} trade${pc > 1 ? "s" : ""} valued on the stablecoin leg only — the SOL price was unavailable at scan time, so their proceeds and P&L are understated (the unpriced SOL side is recorded as a movement).`);
    }
  }
  // fully unpriced movements (an ancient day): lots were consumed with no
  // proceeds and no P&L — the hole must not be silent
  if ((job.result.unpricedMovements ?? 0) > 0) notes.push(`${job.result.unpricedMovements} movement${job.result.unpricedMovements > 1 ? "s" : ""} unpriced (outside the price window) — realized P&L may be incomplete; the shares still moved through the inventory.`);
  if ((job.result.ambiguous ?? 0) > 0) notes.push(`${job.result.ambiguous} older trade${job.result.ambiguous > 1 ? "s" : ""} excluded from P&L as ambiguous (aggregated route, no reliable historical price — the shares still left the inventory).`);
  if ((job.result.reconciled ?? 0) > 0) notes.push(`${job.result.reconciled} position${job.result.reconciled > 1 ? "s" : ""} from the scanned window reconciled to on-chain balances (some movements were not retrievable from public RPC).`);
  if ((job.result.reconcileFailed ?? 0) > 0) notes.push(`On-chain balance unavailable for ${job.result.reconcileFailed} token${job.result.reconcileFailed > 1 ? "s" : ""} — those positions are shown as scanned.`);
  if ((job.result.classifyFailed ?? 0) > 0) notes.push(`Token classification unavailable for ${job.result.classifyFailed} lookup${job.result.classifyFailed > 1 ? "s" : ""} — the report may miss stock trades; please rescan.`);
  if ((job.result.aggregatedDisposals ?? 0) > 0) notes.push(`${job.result.aggregatedDisposals} disposal${job.result.aggregatedDisposals > 1 ? "s" : ""} happened inside multi-token aggregator routes — the cash leg cannot be split across legs, so those proceeds are shown as movements rather than attributed P&L.`);
  if (notes.length) {
    note.textContent = notes.join(" ");
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  lastCloses = disposals;
  $("drows").innerHTML = disposals.slice(0, 100).map((c) => `
    <tr>
      <td class="sym">${esc(c.symbol)}</td>
      <td class="num hint">${c.acquiredTs ? day(c.acquiredTs) : "unknown"}</td>
      <td class="num hint">${day(c.soldTs)}</td>
      <td class="num">${fmtQty(c.qty)}</td>
      <td class="num">${fmt(c.proceedsUsd)}</td>
      <td class="num">${c.costUsd != null ? fmt(c.costUsd) : '<span class="hint">n/a</span>'}</td>
      <td class="num ${c.pnlUsd != null ? (c.pnlUsd >= 0 ? "pos" : "neg") : ""}">${c.pnlUsd != null ? fmt(c.pnlUsd) : '<span class="hint">n/a</span>'}</td>
    </tr>`).join("");
  $("dnote").textContent = disposals.length > 100 ? `Showing 100 of ${disposals.length} disposals — the full list is in the CSV.` : "";
  $("dnote").hidden = disposals.length <= 100;
  $("dtable").hidden = !disposals.length;

  $("rows").innerHTML = rows.map((r) => {
    const noBasis = r.wins + r.losses === 0 && r.unknownBasis > 0 && !showAssumed;
    const val = showAssumed && r.unknownBasis ? r.realizedAssumed : r.realizedUsd;
    const realized = noBasis
      ? `<span class="hint" title="all disposals had unknown cost basis — excluded">n/a</span>`
      : `<span class="${val >= 0 ? "pos" : "neg"}">${fmt(val)}</span>`;
    return `
    <tr>
      <td class="sym">${esc(r.symbol)}<span class="hint"> ${esc(r.name)}</span></td>
      <td class="num">${r.trades}</td>
      <td class="num hint" ${r.unknownBasis ? `title="+${r.unknownBasis} with unknown basis"` : ""}>${r.wins}/${r.losses}</td>
      <td class="num">${realized}</td>
      <td class="num" ${r.openUnknownQty ? `title="${r.openUnknownQty} with unknown basis (custody or unseen deposit)"` : ""}>${r.openQty || r.openUnknownQty ? fmtQty(r.openQty + r.openUnknownQty) : "—"}</td>
      <td class="num">${r.openCostUsd ? fmt(r.openCostUsd) : "—"}</td>
      <td class="num hint act">${dates(r)}</td>
    </tr>`;
  }).join("");

  show("report");
}

// the assumption toggle re-renders the last report without a rescan — but
// only while that report is still the current one: mid-scan it must not
// paint a finished report (and its CSV) over a running progress bar
$("assume").addEventListener("change", () => {
  if (lastJob?.result && lastJobSeq === pollSeq) render(lastJob);
});

$("csv").addEventListener("click", () => {
  // the export belongs to the report on screen: refuse while a newer scan
  // is running, or the file would carry one wallet's rows under another
  // wallet's name
  if (!lastCloses?.length || lastJobSeq !== pollSeq) return;
  const head = "symbol,mint,acquired_date,sold_date,qty,proceeds_usd,cost_basis_usd,gain_usd,assumed_gain_usd";
  const d = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown");
  const lines = lastCloses.map((c) =>
    [csvSafe(c.symbol), csvSafe(c.mint), d(c.acquiredTs), d(c.soldTs), fmtQty(c.qty), c.proceedsUsd.toFixed(2), c.costUsd != null ? c.costUsd.toFixed(2) : "", c.pnlUsd != null ? c.pnlUsd.toFixed(2) : "", c.pnlAssumedUsd != null ? c.pnlAssumedUsd.toFixed(2) : ""].join(",")
  );
  // the BOM makes Excel decode the file as UTF-8 on double-click instead of
  // mangling every non-ASCII ticker through an ANSI code page
  const blob = new Blob(["\uFEFF" + head + "\n" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `stockbasis-${(lastAddress ?? "report").slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

const compact = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => `${n >= 0 ? "+" : "−"}${usd.format(Math.abs(n))}`;
// sub-milli quantities are real movements: show up to 12 decimals instead of
// rounding a booked disposal into a "0" ghost row (a 12-decimals mint's
// smallest unit is exactly 1e-12 and must print as itself)
const fmtQty = (q) => { const d = q !== 0 && Math.abs(q) < 1e-3 ? 12 : 6; return q.toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); };
const csvSafe = (s) => {
  let v = String(s);
  // pure numbers stay numeric even when negative — a leading apostrophe
  // would turn P&L values into text in spreadsheets
  if (!/^-?\d+(\.\d+)?$/.test(v) && /^[=+\-@]/.test(v.trimStart())) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
// dates render in UTC — the same day the CSV and CLI print, so a lot has one
// birthday in every artifact
const day = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
const dates = (r) => (r.firstTs ? `${day(r.firstTs)} → ${day(r.lastTs)}` : "");
// ' is covered too: today the output only lands in double-quoted attributes,
// but a future single-quoted one must not turn an escape into an attribute break
const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (id) => ($(id).hidden = false);
const hide = (id) => ($(id).hidden = true);
function showError(msg) { hide("progress"); hide("report"); $("error").textContent = msg; show("error"); }
