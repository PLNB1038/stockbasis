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
      `<button class="featured" data-addr="${esc(f.address)}"><b>${esc(f.label)}</b><span>${f.address.slice(0, 4)}…${f.address.slice(-4)}</span></button>`
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
    $("market").textContent = `${s.trackedTokens} tokenized-equity pools tracked on Solana${vol}`;
    $("market").title = tops ? `Top pools: ${tops}` : "";
    $("market").hidden = false;
  } catch { /* strip is optional decoration */ }
}

let pollSeq = 0; // a newer submit invalidates an in-flight poll loop

$("scan").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = $("address").value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return showError("That doesn't look like a Solana address.");

  const seq = ++pollSeq;
  lastAddress = address;
  $("go").disabled = true;
  show("progress"); hide("error"); hide("report");

  try {
    const res = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
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
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) throw new Error(res.status === 404 ? "Server restarted — please run the scan again." : `HTTP ${res.status}`);
      job = await res.json();
      flaky = 0;
    } catch {
      if (++flaky > 5) throw new Error("Network error — please scan again.");
      await new Promise((r) => setTimeout(r, 2000 * flaky));
      continue;
    }
    if (job.status === "done") {
      lastJob = job;
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
  const closedDisposals = (job.result.closes ?? []).length;
  $("total-sub").textContent = `${trades} stock trades · ${closedDisposals} closed disposals · ${wins}W/${losses}L · ${tokens} stocks` + covTxt + (showAssumed ? " · market-basis assumption ON" : "");

  const note = $("basis-note");
  const notes = [];
  if (unknownBasis > 0 && !showAssumed) notes.push(`${unknownBasis} disposal${unknownBasis > 1 ? "s" : ""} with unknown cost basis (bought before the scanned history, or deposited from custody) excluded from P&L — tick the box above to assume market price.`);
  if ((job.result.priceCorrections ?? 0) > 0) notes.push(`${job.result.priceCorrections} recent trade${job.result.priceCorrections > 1 ? "s" : ""} valued at market price (cash leg ambiguous in an aggregated route).`);
  if ((job.result.ambiguous ?? 0) > 0) notes.push(`${job.result.ambiguous} older trade${job.result.ambiguous > 1 ? "s" : ""} excluded as ambiguous (aggregated route, no reliable historical price).`);
  if (notes.length) {
    note.textContent = notes.join(" ");
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  const closes = job.result.closes ?? [];
  lastCloses = closes;
  $("drows").innerHTML = closes.slice(0, 100).map((c) => `
    <tr>
      <td class="sym">${esc(c.symbol)}</td>
      <td class="num hint">${c.acquiredTs ? day(c.acquiredTs) : "unknown"}</td>
      <td class="num hint">${day(c.soldTs)}</td>
      <td class="num">${fmtQty(c.qty)}</td>
      <td class="num">${fmt(c.proceedsUsd)}</td>
      <td class="num">${fmt(c.costUsd)}</td>
      <td class="num ${c.pnlUsd >= 0 ? "pos" : "neg"}">${fmt(c.pnlUsd)}</td>
    </tr>`).join("");
  if (closes.length > 100) {
    $("dnote").textContent = `Showing 100 of ${closes.length} disposals — the full list is in the CSV.`;
    $("dnote").hidden = false;
  } else if (closes.length) {
    $("dnote").hidden = true;
  }
  $("dtable").hidden = !closes.length;
  $("dnote").hidden = closes.length <= 100;

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
      <td class="num">${r.openQty ? fmtQty(r.openQty) : "—"}</td>
      <td class="num">${r.openCostUsd ? fmt(r.openCostUsd) : "—"}</td>
      <td class="num hint">${dates(r)}</td>
    </tr>`;
  }).join("");

  show("report");
}

// the assumption toggle re-renders the last report without a rescan
$("assume").addEventListener("change", () => {
  if (lastJob?.result) render(lastJob);
});

$("csv").addEventListener("click", () => {
  if (!lastCloses?.length) return;
  const head = "symbol,mint,acquired_date,sold_date,qty,proceeds_usd,cost_basis_usd,gain_usd";
  const d = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown");
  const lines = lastCloses.map((c) =>
    [csvSafe(c.symbol), csvSafe(c.mint), d(c.acquiredTs), d(c.soldTs), fmtQty(c.qty), c.proceedsUsd.toFixed(2), c.costUsd.toFixed(2), c.pnlUsd.toFixed(2)].join(",")
  );
  const blob = new Blob([head + "\n" + lines.join("\n")], { type: "text/csv" });
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
const fmtQty = (q) => Number(q.toFixed(6)).toString();
const csvSafe = (s) => {
  let v = String(s);
  // pure numbers stay numeric even when negative — a leading apostrophe
  // would turn P&L values into text in spreadsheets
  if (!/^-?\d+(\.\d+)?$/.test(v) && /^[=+\-@]/.test(v.trimStart())) v = "'" + v;
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
const day = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dates = (r) => {
  if (!r.firstTs) return "";
  const f = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(r.firstTs)} → ${f(r.lastTs)}`;
};
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const show = (id) => ($(id).hidden = false);
const hide = (id) => ($(id).hidden = true);
function showError(msg) { hide("progress"); hide("report"); $("error").textContent = msg; show("error"); }
