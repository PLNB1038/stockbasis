import test from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/csv.mjs";

/** Minimal strict RFC-4180 parser: quotes, escaped quotes, CRLF/LF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test("csv output parses strictly and preserves fields", () => {
  const csv = toCsv([
    { symbol: "NVDAx", mint: "MintA", acquiredTs: 1700000000, soldTs: 1700100000, qty: 1.5, proceedsUsd: 300.456, costUsd: 250, pnlUsd: 50.456 },
    { symbol: "SPYx", mint: "MintB", acquiredTs: null, soldTs: 1700200000, qty: 0.25, proceedsUsd: 195.5, costUsd: 0, pnlUsd: 195.5 },
  ]);
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ["symbol", "mint", "acquired_date", "sold_date", "qty", "proceeds_usd", "cost_basis_usd", "gain_usd"]);
  assert.equal(rows[1][0], "NVDAx");
  assert.equal(rows[1][2], "2023-11-14"); // 1700000000
  assert.equal(rows[1][3], "2023-11-16"); // 1700100000
  assert.equal(rows[1][4], "1.5");
  assert.equal(rows[1][7], "50.46");
  assert.equal(rows[2][2], "unknown"); // no acquisition date
});

test("csv neutralizes spreadsheet formula injection", () => {
  const csv = toCsv([
    { symbol: "=HYPERLINK(\"https://evil\")", mint: "M", acquiredTs: 1, soldTs: 2, qty: 1, proceedsUsd: 1, costUsd: 1, pnlUsd: 0 },
    { symbol: "+SUM(A1:A9)", mint: "M", acquiredTs: 1, soldTs: 2, qty: 1, proceedsUsd: 1, costUsd: 1, pnlUsd: 0 },
    { symbol: "@macroname", mint: "M", acquiredTs: 1, soldTs: 2, qty: 1, proceedsUsd: 1, costUsd: 1, pnlUsd: 0 },
  ]);
  for (const line of csv.split("\n").slice(1, 4)) {
    const first = parseCsv(line + "\n")[0][0];
    assert.ok(!/^[=+@]/.test(first), `unsafe CSV cell: ${first}`);
  }
});

test("negative numbers stay numeric (no formula-guard apostrophe)", () => {
  const csv = toCsv([
    { symbol: "TSLAx", mint: "M", acquiredTs: 1, soldTs: 2, qty: 0.743964, proceedsUsd: 271.81, costUsd: 273.75, pnlUsd: -1.94 },
  ]);
  const row = parseCsv(csv)[1];
  assert.equal(row[7], "-1.94"); // no leading apostrophe on negative P&L
  assert.equal(row[5], "271.81");
  assert.ok(!Number.isNaN(Number(row[7])), "gain_usd must parse as a number");
});

test("minus-prefixed text still gets the injection guard", () => {
  const csv = toCsv([
    { symbol: "-1+1", mint: "M", acquiredTs: 1, soldTs: 2, qty: 1, proceedsUsd: 1, costUsd: 1, pnlUsd: 0 },
  ]);
  const first = parseCsv(csv)[1][0];
  assert.ok(first.startsWith("'-"), `unsafe CSV cell: ${first}`);
});
