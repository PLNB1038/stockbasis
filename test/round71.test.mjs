// Regression tests for polish round 71 (SB24). Every test pins one confirmed vector:
//   server: boot with a missing featured.json (retry armed) -> a dict-shaped file
//   lands (flag once, retry cleared) -> the operator fixes the file WITHOUT a
//   restart: the precompute leg must recover — revalidated by the very rounds the
//   bad shape armed — with one "recovered" line, not spam

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
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

const spawnServer = async (dir, env = {}) => {
  // below the Windows ephemeral range (49152+) and disjoint from the sibling
  // files' 22000-47000 bands, so sibling test files cannot steal the port mid-spawn
  const port = 48000 + Math.floor(Math.random() * 1000);
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

test("server: missing -> dict-shaped -> hand-fixed featured.json heals the precompute leg without a restart", { timeout: 30_000 }, async () => {
  const dir = await tmpRepo("sb-r71-");
  await rm(path.join(dir, "data", "featured.json")); // the volume has not mounted yet
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
    SOLANA_RPC: interactive.url, PRECOMPUTE_RPC: precompute.url,
    FEATURED_RELOAD_MS: "100", PRECOMPUTE_INTERVAL_MIN: "0.05", STOCKBASIS_NO_MARKET: "1",
  });
  assert.ok(await waitReady(base), `server child did not come up (stderr: ${stderr().slice(0, 400)})`);
  try {
    // phase 1: missing file — the round69 retry semantics hold, and until the
    // first successful load nothing arms the precompute schedule
    for (let i = 0; i < 100 && !stderr().includes("featured load failed"); i++) await sleep(100);
    assert.ok(stderr().includes("featured load failed"), "precondition: the missing file armed the load retry");
    assert.equal(precomputeLog.length, 0, "no precompute rounds may run while the file is missing");

    // phase 2: a dict-shaped file lands (an error envelope copied over the
    // volume): flagged loudly ONCE, retry timer cleared for good
    await writeFile(path.join(dir, "data", "featured.json"), "{}");
    for (let i = 0; i < 100 && !stderr().includes("featured.json holds object, not a list"); i++) await sleep(100);
    assert.ok(stderr().includes("featured.json holds object, not a list"), "the bad shape must be flagged loudly");
    await sleep(800); // several (now cleared) retry ticks' worth + several precompute rounds
    const flags = stderr().split("featured.json holds object, not a list").length - 1;
    assert.equal(flags, 1, `the shape flag must log once, not per revalidation (got ${flags} in: ${stderr().slice(0, 400)})`);

    // phase 3 (SB24): the operator fixes the file WITHOUT a restart — the next
    // precompute round revalidates the file, announces the recovery once, and
    // the wallet list (with it the scans) comes back to life
    await writeFile(path.join(dir, "data", "featured.json"), JSON.stringify([{ address: OWNER, label: "fixed by hand" }]));
    let healed = false;
    for (let i = 0; i < 150 && !healed; i++) {
      healed = stderr().includes("featured.json recovered") && precomputeLog.includes("getSignaturesForAddress");
      if (!healed) await sleep(100);
    }
    assert.ok(healed, `the precompute leg must recover without a restart (stderr tail: ${stderr().slice(-400)}, rpc log: ${precomputeLog.slice(0, 10)})`);
    const heals = stderr().split("featured.json recovered").length - 1;
    assert.equal(heals, 1, `the recovery must be announced once, not per round (got ${heals} in: ${stderr().slice(-400)})`);
    assert.equal(stderr().split("featured.json holds object, not a list").length - 1, 1, "the shape flag must stay at exactly one line across the whole scenario");

    // the strip side of the same file heals too (it always did)
    const strip = await (await fetch(base + "/api/featured")).json();
    assert.deepEqual(strip, [{ address: OWNER, label: "fixed by hand" }]);
  } finally { child.kill("SIGKILL"); }
});
