// Repo hygiene meta-tests: the classes of defects external reviewers caught
// here once (a malformed mint constant, dead exports with stale comments) must
// never survive a local `npm test` again.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STABLES, lookupToken } from "../src/classify.mjs";
import { WSOL } from "../src/ingest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// base58 with a leading-'1' = zero byte; a Solana pubkey decodes to 32 bytes
function base58ByteLen(s) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return -1;
    n = n * 58n + BigInt(i);
  }
  let lead = 0;
  for (const ch of s) { if (ch === "1") lead++; else break; }
  let bytes = 0;
  while (n > 0n) { bytes++; n >>= 8n; }
  return bytes + lead;
}

function assertValidPubkey(addr, where) {
  assert.ok(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(addr), `${where}: not base58-shaped: ${addr}`);
  assert.equal(base58ByteLen(addr), 32, `${where}: does not decode to a 32-byte pubkey: ${addr}`);
}

test("every mint constant is a valid 32-byte base58 pubkey", () => {
  // the STABLES set decides what counts as a cash leg — a typo here silently
  // misclassifies trades (a 42-char impostor once lived here unnoticed)
  for (const mint of STABLES) assertValidPubkey(mint, `STABLES`);
  assertValidPubkey(WSOL, "WSOL");
  const stocks = JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url), "utf8"));
  for (const mint of Object.keys(stocks)) assertValidPubkey(mint, "stocks.json");
  const featured = JSON.parse(readFileSync(new URL("../data/featured.json", import.meta.url), "utf8"));
  for (const f of featured) {
    assertValidPubkey(f.address, "featured.json address");
    assert.ok(typeof f.label === "string" && f.label.length > 0 && f.label.length <= 80, `featured.json label: ${f.label}`);
  }
});

test("stocks.json: unique CSV-safe symbols, non-empty names", () => {
  const stocks = JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url), "utf8"));
  const symbols = new Set();
  for (const [mint, v] of Object.entries(stocks)) {
    assert.ok(v.symbol && !/[",\n=+@]/.test(v.symbol), `symbol unsafe for CSV: ${mint} ${v.symbol}`);
    assert.ok(v.name && v.name.length > 0, `empty name for ${mint}`);
    assert.ok(!symbols.has(v.symbol), `duplicate symbol ${v.symbol}`);
    symbols.add(v.symbol);
  }
});

test("no dead exports: every exported symbol is referenced outside its own file", () => {
  const srcDir = path.join(ROOT, "src");
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".mjs"));
  // search space: every repo source file except the one that declares it
  const corpus = new Map();
  const collect = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) collect(p);
      else if (/\.(mjs|js)$/.test(f.name)) corpus.set(p, readFileSync(p, "utf8"));
    }
  };
  collect(path.join(ROOT, "src"));
  collect(path.join(ROOT, "scripts"));
  collect(path.join(ROOT, "test"));
  collect(path.join(ROOT, "web"));

  const dead = [];
  for (const f of files) {
    const p = path.join(srcDir, f);
    const own = readFileSync(p, "utf8");
    const names = [...own.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    for (const name of names) {
      const re = new RegExp(`\\b${name}\\b`);
      let referenced = false;
      for (const [other, content] of corpus) {
        if (other === p) continue;
        if (re.test(content)) { referenced = true; break; }
      }
      if (!referenced) dead.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(dead, [], "exports nobody imports — dead code or a stale facade; delete or wire it up");
});

test("curated list classifies as stocks without any network", async () => {
  // every stocks.json entry must come back isStock from the curated path —
  // if one stops resolving, reports silently lose a whole ticker
  const stocks = JSON.parse(readFileSync(new URL("../data/stocks.json", import.meta.url), "utf8"));
  for (const [mint, v] of Object.entries(stocks)) {
    const meta = await lookupToken(mint);
    assert.equal(meta?.isStock, true, `${v.symbol} (${mint}) not classified as stock`);
    assert.equal(meta?.symbol, v.symbol, `${mint} symbol mismatch: cache says ${meta?.symbol}`);
  }
});
