// StockBasis UI: scan a wallet, poll the job, render the report.

const $ = (id) => document.getElementById(id);
let lastResult = null;
let lastAddress = null;

loadFeatured();
loadMarket();

async function loadFeatured() {
  try {
    const list = await (await fetch("/api/featured")).json();
    if (!list.length) return;
    $("featured").hidden = false;
    $("featured-list").innerHTML = list.map((f) =>
      `<button class="featured" data-addr="${f.address}"><b>${esc(f.label)}</b><span>${f.address.slice(0, 4)}…${f.address.slice(-4)}</span></button>`
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
    $("market").textContent = `${s.trackedTokens} tokenized equities tracked on Solana${vol}`;
    $("market").title = tops ? `Top pools: ${tops}` : "";
    $("market").hidden = false;
  } catch { /* strip is optional decoration */ }
}

$("scan").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = $("address").value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return showError("That doesn't look like a Solana address.");

  lastAddress = address;
  $("go").disabled = true;
  show("progress"); hide("error"); hide("report");

  try {
    const res = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    await poll(body.id);
  } catch (err) {
    showError(String(err.message ?? err));
  } finally {
    $("go").disabled = false;
  }
});

async function poll(id) {
  for (;;) {
    const res = await fetch(`/api/jobs/${id}`);
    const job = await res.json();
    if (job.status === "done") return render(job);
    if (job.status === "error") throw new Error(job.error);
    $("progress-text").textContent = job.phase === "history"
      ? `Walking transaction history… ${job.progress} signatures`
      : `Scanned ${job.progress} transactions · ${job.trades} stock trades found`;
    $("bar-fill").style.width = `${Math.min(95, 8 + (job.trades / 30) * 87)}%`;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function render(job) {
  const { rows, totalRealized, tokens, unknownBasis } = job.result;
  lastResult = rows;

  hide("progress");
  if (!rows.length) return showError("No tokenized-stock trades found in the scanned history. Try one of the wallets below the form.");

  const wins = rows.reduce((s, r) => s + r.wins, 0);
  const losses = rows.reduce((s, r) => s + r.losses, 0);
  const trades = rows.reduce((s, r) => s + r.trades, 0);

  const total = $("total");
  total.textContent = `${totalRealized >= 0 ? "+" : "−"}$${Math.abs(totalRealized).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  total.className = `total-value ${totalRealized >= 0 ? "pos" : "neg"}`;
  $("total-sub").textContent = `${trades} closed trades · ${wins}W/${losses}L · ${tokens} stocks · wallet ${job.address.slice(0, 4)}…${job.address.slice(-4)}`;

  const note = $("basis-note");
  const notes = [];
  if (unknownBasis > 0) notes.push(`${unknownBasis} disposal${unknownBasis > 1 ? "s" : ""} with unknown cost basis (shares bought before the scanned history) excluded from P&L.`);
  if ((job.result.priceCorrections ?? 0) > 0) notes.push(`${job.result.priceCorrections} trade${job.result.priceCorrections > 1 ? "s" : ""} valued at market price (cash leg ambiguous in an aggregated route).`);
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
      <td class="num">${c.qty}</td>
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
    const noBasis = r.wins + r.losses === 0 && r.unknownBasis > 0;
    const realized = noBasis
      ? `<span class="hint" title="all disposals had unknown cost basis — excluded">n/a</span>`
      : `<span class="${r.realizedUsd >= 0 ? "pos" : "neg"}">${fmt(r.realizedUsd)}</span>`;
    return `
    <tr>
      <td class="sym">${esc(r.symbol)}<span class="hint"> ${esc(r.name)}</span></td>
      <td class="num">${r.trades}</td>
      <td class="num hint" ${r.unknownBasis ? `title="+${r.unknownBasis} with unknown basis"` : ""}>${r.wins}/${r.losses}</td>
      <td class="num">${realized}</td>
      <td class="num">${r.openQty ? r.openQty : "—"}</td>
      <td class="num">${r.openCostUsd ? fmt(r.openCostUsd) : "—"}</td>
      <td class="num hint">${dates(r)}</td>
    </tr>`;
  }).join("");

  show("report");
}

let lastCloses = null;

$("csv").addEventListener("click", () => {
  if (!lastCloses?.length) return;
  const head = "symbol,acquired_date,sold_date,qty,proceeds_usd,cost_basis_usd,gain_usd";
  const d = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown");
  const lines = lastCloses.map((c) =>
    [c.symbol, d(c.acquiredTs), d(c.soldTs), c.qty, c.proceedsUsd.toFixed(2), c.costUsd.toFixed(2), c.pnlUsd.toFixed(2)].join(",")
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
const fmt = (n) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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
