// Display-honesty regressions from the fifth adversarial pass:
//   1. one birthday everywhere: UI dates in UTC, matching the CSV and CLI
//   2. sub-micro quantities never render as "0"
//   3. "stock trades found" counts buys/sells, not custody movements
//   4. unknown-basis disposals reach the payload and the CSV with real proceeds
//   5. break-even is neither a win nor a loss

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.STOCKBASIS_NO_MARKET ??= "1";

const { buildReport } = await import("../src/report.mjs");
const { toCsv } = await import("../src/csv.mjs");
const { perStockSummary } = await import("../src/basis.mjs");
const { ingestWallet } = await import("../src/ingest.mjs");
const { primeTokenCache } = await import("../src/classify.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
primeTokenCache(USDC, { symbol: "USDC", name: "", isStock: false, tags: [] });
primeTokenCache(TSLAX, { symbol: "TSLAx", name: "", isStock: true, tags: [] });

const appSrc = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
// extract the one-line client formatters so their behavior is testable
// without a DOM (the browser bundle stays dependency-free by design)
const fnFromBody = (name, arg) => {
  const body = appSrc.match(new RegExp(`const ${name} = \\(${arg}\\) => (.+);$`, "m"))[1];
  return new Function(arg, body.startsWith("{") ? body : `return (${body});`);
};

test("ui formatter: disposal dates render in UTC, the same day as the CSV", () => {
  const day = fnFromBody("day", "ts");
  const ts = Date.UTC(2026, 8, 14, 23, 30) / 1000; // 23:30 UTC — already the next day in UTC+3
  assert.equal(day(ts), "Sep 14", "the browser's local timezone must not move a disposal's date");
  const csvLine = toCsv([{ symbol: "TSLAx", mint: "M".repeat(40), acquiredTs: ts, soldTs: ts, qty: 1, proceedsUsd: 150, costUsd: 100, pnlUsd: 50 }]).split("\n")[1];
  assert.ok(csvLine.includes("2026-09-14"), csvLine); // CSV and UI now agree
});

test("sub-micro quantities stay visible in the CSV and the UI formatter", () => {
  const fmtQty = fnFromBody("fmtQty", "q");
  assert.equal(fmtQty(2e-7), "0.0000002", "a booked disposal must not render as qty 0");
  assert.equal(fmtQty(1), "1");
  assert.equal(fmtQty(0.5), "0.5");
  const line = toCsv([{ symbol: "TSLAx", mint: "M".repeat(40), acquiredTs: 1, soldTs: 2, qty: 2e-7, proceedsUsd: 3e-5, costUsd: 3e-5, pnlUsd: 0 }]);
  assert.ok(line.includes(",0.0000002,"), line);
});

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

test("progress: the trades counter counts buys/sells only, like the stop target", async () => {
  let slot = 1000, tslax = 0;
  const sigs = [], txs = new Map();
  const push = (deltas) => {
    slot += 10;
    const sig = `Sig${String(slot).padStart(6, "0")}${"q".repeat(30)}`;
    const meta = { preTokenBalances: [], postTokenBalances: [], preBalances: [1e9], postBalances: [1e9], fee: 5000 };
    for (const [mint, d] of deltas) {
      const pre = mint === TSLAX ? tslax : 0;
      if (mint === TSLAX) tslax += d;
      meta.preTokenBalances.push({ accountIndex: 1, mint, owner: OWNER, uiTokenAmount: { uiAmount: pre, uiAmountString: String(pre) } });
      meta.postTokenBalances.push({ accountIndex: 1, mint, owner: OWNER, uiTokenAmount: { uiAmount: pre + d, uiAmountString: String(pre + d) } });
    }
    txs.set(sig, { meta, transaction: { message: { accountKeys: [{ pubkey: OWNER }] } } });
    sigs.push({ signature: sig, slot, blockTime: 1_700_000_000 + slot, err: null });
  };
  for (let i = 0; i < 14; i++) {
    push([[TSLAX, 10]]);              // custody deposit — a movement, not a trade
    push([[TSLAX, 1], [USDC, -150]]); // real buy
  }
  push([[TSLAX, 11]]);
  sigs.reverse();

  const stub = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(b);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "getSignaturesForAddress" ? sigs : (txs.get(params[0]) ?? null) }));
    });
  });
  servers.push(stub);
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));

  const reports = [];
  await ingestWallet(OWNER, { rpcUrl: `http://127.0.0.1:${stub.address().port}`, maxScanTx: 100, targetStockTrades: 30, onProgress: (p) => reports.push({ ...p }) });
  const last = reports[reports.length - 1];
  assert.equal(last.trades, 14, `"${last.trades} stock trades found" must not count custody movements`);
});

test("unknown-basis disposals reach the payload and the CSV with their real proceeds", async () => {
  const T = 1_700_000_000;
  const report = await buildReport([
    { side: "in", mint: TSLAX, qty: 10, valueUsd: 0, ts: T, slot: 1 },               // deposited from custody
    { side: "sell", mint: TSLAX, qty: 10, valueUsd: 5000, ts: T + 86400, slot: 2 },  // sold for a very real $5000
  ]);
  assert.equal(report.unknownCloses.length, 1);
  assert.equal(report.unknownCloses[0].proceedsUsd, 5000);
  assert.equal(report.disposals.length, 1);
  const line = toCsv(report.disposals).split("\n")[1];
  assert.ok(line.includes("5000.00"), `proceeds must be exported (got: ${line})`);
  assert.ok(/unknown,.*,5000\.00,,,$/.test(line), `cost/gain/assumed must be empty cells, never a guess (got: ${line})`);
});

test("w/l: a break-even close is neither a win nor a loss", () => {
  const M = "Mint111111111111111111111111111111111111111111";
  const trades = [
    { side: "buy", mint: M, qty: 10, valueUsd: 1000, ts: 1_700_000_000, slot: 1 },
    { side: "sell", mint: M, qty: 10, valueUsd: 1000, ts: 1_700_000_3600, slot: 2 }, // sold at exactly cost
  ];
  const row = perStockSummary(new Map([[M, trades]]), () => ({ symbol: "TSLAx", name: "" }))[0];
  assert.equal(row.wins, 0);
  assert.equal(row.losses, 0, "a wash trade must not read as 0W/1L");
});
