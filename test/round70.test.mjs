// Regression tests for review round 70. Every test pins one confirmed vector:
//   featured-traders: a dexscreener error envelope (valid JSON, not an array) skips the symbol, exit 0
//   featured-traders: a dexscreener JSON-string body skips the symbol too, exit 0
//   server: a dict-shaped featured.json is flagged loudly, still arms the precompute, does not retry forever, and self-heals when the file is fixed (round71/SB24)
//   server: a string featured.json is flagged once instead of N entry-rejected lines

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

process.env.RPC_MAX_RETRIES ??= "2";
process.env.RPC_MIN_INTERVAL_MS ??= "0";
process.env.STOCKBASIS_NO_MARKET ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped
const T = 1_700_000_000;

const servers = [];
const children = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const out = handler(msg, req, res);
      if (out === undefined) return; // handler wrote the response itself
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
});

const tmpRepo = async (prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  for (const d of ["src", "web", "data"]) await cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await cp(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
};

const runNode = async (args, { env = {}, preload } = {}) => {
  const child = spawn(process.execPath, preload ? ["--require", preload, ...args] : args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return { code, out, err };
};

const spawnServer = async (dir, env = {}) => {
  // below the Windows ephemeral range (49152+) and disjoint from round69's
  // 42000-45000 band, so sibling test files cannot steal the port mid-spawn
  const port = 45000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  return { child, base: `http://127.0.0.1:${port}`, stderr: () => err, stdout: () => out };
};

const waitReady = async (base) => {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + "/api/featured"); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- featured-traders: non-array dexscreener JSON ------------------------------

// The round69 outage fix guards fetch/res.json() only; any body that PARSES
// into a non-array JSON value (a proxy or Cloudflare error envelope like
// {"error":...}) sails past `pairs ?? []` and dies on pairs.sort — killing the
// whole run exactly like the outage the fix promised to survive.
test("featured-traders: a non-array dexscreener body skips the symbol and keeps exit 0", { timeout: 30_000 }, async () => {
  const stocks = JSON.parse(readFileSync(path.join(ROOT, "data", "stocks.json"), "utf8"));
  const sym = Object.values(stocks)[0].symbol;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sb-r70-"));

  const stubFetch = (body) => `
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (String(u).includes('dexscreener')) return { ok: true, status: 200, json: async () => ${body} };
      return real(u, o);
    };`;

  try {
    // shape 1: an error envelope object — parses fine, is not a pair list
    const preloadObj = path.join(tmp, "dex-envelope.cjs");
    await writeFile(preloadObj, stubFetch('({ error: "rate limited", status: 429 })'));
    const env = await runNode(["scripts/featured-traders.mjs", sym], { preload: preloadObj });
    assert.equal(env.code, 0, `an error-envelope body must not kill the run (stderr: ${env.err.slice(0, 300)})`);
    assert.ok(env.err.includes(`(skip ${sym}: dexscreener answered a non-list`), `the skip must be announced (stderr: ${env.err.slice(0, 300)})`);
    assert.ok(!env.out.includes(`# ${sym}`), "no pool results may print for a skipped symbol");

    // shape 2: a bare JSON string body ("Forbidden") — same TypeError on .sort
    const preloadStr = path.join(tmp, "dex-string.cjs");
    await writeFile(preloadStr, stubFetch('("Forbidden")'));
    const str = await runNode(["scripts/featured-traders.mjs", sym], { preload: preloadStr });
    assert.equal(str.code, 0, `a string body must not kill the run (stderr: ${str.err.slice(0, 300)})`);
    assert.ok(str.err.includes(`(skip ${sym}: dexscreener answered a non-list`), `the skip must be announced (stderr: ${str.err.slice(0, 300)})`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ---- server: wrong-shaped featured.json ----------------------------------------

test("server: a dict-shaped featured.json is flagged loudly, still arms the precompute, and heals when the file is fixed", { timeout: 30_000 }, async () => {
  const dir = await tmpRepo("sb-r70-");
  await writeFile(path.join(dir, "data", "featured.json"), "{}"); // valid JSON, wrong shape
  const precomputeLog = [];
  const precompute = await stubServer((msg) => {
    precomputeLog.push(msg.method);
    if (msg.method === "getSignaturesForAddress") return { result: [{ signature: "sig1", slot: 1, blockTime: T, err: null }] };
    if (msg.method === "getTransaction") return { result: { transaction: { message: { accountKeys: [{ pubkey: OWNER }] } }, meta: {} } };
    if (msg.method === "getTokenAccountsByOwner") return { result: { value: [] } };
    return { result: [] };
  });
  const interactive = await stubServer(() => ({ result: [] }));
  const { child, base, stderr } = await spawnServer(dir, {
    SOLANA_RPC: interactive.url, PRECOMPUTE_RPC: precompute.url, FEATURED_RELOAD_MS: "250",
    PRECOMPUTE_INTERVAL_MIN: "0.05", STOCKBASIS_NO_MARKET: "1",
  });
  assert.ok(await waitReady(base), `server child did not come up (stderr: ${stderr().slice(0, 400)})`);
  try {
    // the wrong shape must be announced, not mistaken for a transient outage
    for (let i = 0; i < 30 && !stderr().includes("featured.json holds object, not a list"); i++) await sleep(100);
    assert.ok(stderr().includes("featured.json holds object, not a list"), `the shape flag must be loud (stderr: ${stderr().slice(0, 400)})`);

    // armPrecompute must still fire — the server must not sit in limbo with a
    // dead featured leg and no hourly round (old code: only armed on success)
    assert.ok(stderr().includes("precompute round start"), "the precompute schedule must still be armed");

    // a wrong-shaped file cannot heal on its own, so it must NOT enter the
    // missing-volume retry loop: the old code logged "featured load failed"
    // every FEATURED_RELOAD_MS until someone edited the file
    await sleep(1_200); // many precompute rounds' worth of revalidation ticks
    const flags = stderr().split("featured.json holds object, not a list").length - 1;
    assert.equal(flags, 1, `the flag must be logged once, not retried forever (got ${flags} in: ${stderr().slice(0, 400)})`);
    assert.ok(!stderr().includes("featured load failed"), `a shape problem is not a load failure (stderr: ${stderr().slice(0, 400)})`);

    // SB24 (round71): fixing the file WITHOUT a restart heals the precompute
    // leg — the next precompute round revalidates the file, announces the
    // recovery once, and scans the wallets again (the old pin here demanded a
    // restart: rounds stayed silently empty forever after a dict landed)
    await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: OWNER, label: "fixed by hand" }]));
    let healed = false;
    for (let i = 0; i < 150 && !healed; i++) {
      healed = stderr().includes("featured.json recovered") && precomputeLog.includes("getSignaturesForAddress");
      if (!healed) await sleep(100);
    }
    assert.ok(healed, `a fixed file must bring the precompute leg back (stderr tail: ${stderr().slice(-400)}, rpc log: ${precomputeLog.slice(0, 10)})`);
    const heals = stderr().split("featured.json recovered").length - 1;
    assert.equal(heals, 1, `the recovery must be one line, not per-round spam (got ${heals} in: ${stderr().slice(-400)})`);
    // ...while the landing strip re-reads the file per request and self-heals
    const strip = await (await fetch(base + "/api/featured")).json();
    assert.deepEqual(strip, [{ address: OWNER, label: "fixed by hand" }], "the /api/featured strip must keep self-healing from the file");
  } finally { child.kill("SIGKILL"); }
});

test("server: a string featured.json is flagged once instead of N entry-rejected lines", { timeout: 30_000 }, async () => {
  const dir = await tmpRepo("sb-r70-");
  await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify("just a string")); // valid JSON, iterable, not a list
  const precompute = await stubServer(() => ({ result: [] }));
  const interactive = await stubServer(() => ({ result: [] }));
  const { child, base, stderr } = await spawnServer(dir, {
    SOLANA_RPC: interactive.url, PRECOMPUTE_RPC: precompute.url, FEATURED_RELOAD_MS: "250", STOCKBASIS_NO_MARKET: "1",
  });
  assert.ok(await waitReady(base), `server child did not come up (stderr: ${stderr().slice(0, 400)})`);
  try {
    for (let i = 0; i < 30 && !stderr().includes("featured.json holds string, not a list"); i++) await sleep(100);
    assert.ok(stderr().includes("featured.json holds string, not a list"), `the shape flag must name what it got (stderr: ${stderr().slice(0, 400)})`);
    // a string iterates by characters: the old code logged one "entry rejected
    // (bad address)" line per character and stayed silently empty
    assert.ok(!stderr().includes("entry rejected"), `no per-character junk may be logged (stderr: ${stderr().slice(0, 400)})`);
    // round71: раунд стартует после ревалидации featured.json — лог идёт чуть позже флага формы
    for (let i = 0; i < 30 && !stderr().includes("precompute round start"); i++) await sleep(100);
    assert.ok(stderr().includes("precompute round start"), "the precompute schedule must still be armed");
  } finally { child.kill("SIGKILL"); }
});
