// Lifecycle regressions from the third adversarial pass:
//   1. duplicate RPC endpoints must not spin the not-found rotation forever
//   2. the jobs map is bounded — a cheap-create loop cannot eat memory
//   3. a cancelled scan stops paying for RPC during reconciliation too
//   4. /api/stats shares one upstream call per burst and survives throttling

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { rpc } = await import("../src/rpc.mjs");
const { buildReconciledReport } = await import("../src/reconcile.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // curated — no Jupiter calls
const OWNER = "Aaaa1111111111111111111111111111111111111111"; // base58-shaped

const servers = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(out.error ? { error: out.error } : { result: out.result }) }));
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const waitReady = async (base) => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/")).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

after(() => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
});

test("rpc: request-class errors fail fast instead of burning retries", async () => {
  let hits = 0;
  const stub = await stubServer(() => { hits++; return { error: { code: -32602, message: "Invalid param: WrongSize" } }; });
  const t0 = Date.now();
  await assert.rejects(
    rpc("getSignaturesForAddress", ["ShortButValidBase58AddrHere123456789", { limit: 1000 }], { rpcUrl: stub.url }),
    /-32602|WrongSize/,
  );
  assert.equal(hits, 1, `a permanent param error needs exactly 1 request (made ${hits})`);
  assert.ok(Date.now() - t0 < 3000, "fail-fast expected, not a backoff storm");
});

const spawnStats = async (dsMode) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join("test", "fixtures", "stats-child.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DS_MODE: dsMode, SB_FIXTURE_SPAWNED: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/api/stats"); if (r.ok) return { child, base, first: await r.json() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("stats child did not come up");
};

test("stats: a prototype-keyed pair cannot enter the strip untracked", async () => {
  const { child, first } = await spawnStats("proto");
  try {
    assert.equal(first.top.length, 1, `exactly the real tracked pair (got ${JSON.stringify(first.top)})`);
    assert.ok(first.top[0].symbol, "every strip row must carry a symbol");
    assert.equal(first.volume24hUsd, 12345, "the phantom's 999999999 must not be summed");
  } finally { child.kill("SIGKILL"); }
});

test("stats: one malformed volume field must not kill the whole strip", async () => {
  const { child, first } = await spawnStats("nan");
  try {
    assert.equal(first.volume24hUsd, 12345, `the healthy pair's volume survives (got ${first.volume24hUsd})`);
    assert.equal(first.tokensWithPools, 1);
  } finally { child.kill("SIGKILL"); }
});

test("rpc: a mirror listed twice must fail honestly, not loop the not-found rotation", async () => {
  let holeHits = 0;
  const hole = await stubServer(() => { holeHits++; return { error: { code: -32020, message: "Transaction not found" } }; });
  const healthy = await stubServer(() => ({ result: { version: "ok" } }));

  const verdict = await Promise.race([
    rpc("getTransaction", ["sig", {}], { rpcUrl: `${hole.url},${hole.url}` }).then(() => "resolved", (e) => e.name ?? "rejected"),
    new Promise((r) => setTimeout(() => r("HUNG"), 5000)),
  ]);
  assert.notEqual(verdict, "HUNG", "duplicate endpoints must terminate with an error, not retry forever");
  assert.ok(holeHits > 0 && holeHits < 50, `rotation must stay bounded (${holeHits} attempts)`);

  // the shared queue must still serve after the failed call — one poisoned
  // caller must not deadlock every other scan
  assert.equal((await rpc("getVersion", [], { rpcUrl: healthy.url })).version, "ok");
});

test("reconcile: a cancelled scan stops paying for RPC", async () => {
  let hits = 0;
  const fake = await stubServer(() => { hits++; return { result: { value: [] } }; });
  const ac = new AbortController();
  ac.abort(new Error("scan timed out"));
  const trades = [{ side: "buy", mint: TSLAX, qty: 1, valueUsd: 100, ts: 1_700_000_000, slot: 1 }];
  await assert.rejects(buildReconciledReport(OWNER, trades, { rpcUrl: fake.url, signal: ac.signal }));
  assert.equal(hits, 0, "no balance reads may leave after the scan was cancelled");
});

test("server: the jobs map is bounded under a create loop", async () => {
  const fake = await stubServer((msg) => (msg.method === "getSignaturesForAddress" ? { result: [] } : { result: null }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SOLANA_RPC: fake.url,
      STOCKBASIS_NO_FEATURED: "1",
      STOCKBASIS_NO_MARKET: "1",
      MAX_JOBS: "5",
      JOB_EVICTION_GRACE_MS: "0", // this test targets boundedness; freshness is covered separately
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.ok(await waitReady(base), "server did not come up");
  const ids = [];
  try {
    for (let i = 0; i < 12; i++) {
      const address = `B${"123456789"[i % 9]}${"123456789"[Math.floor(i / 9)]}${"b".repeat(39)}`; // distinct, digits 1-9 only (no base58-forbidden chars)
      const res = await fetch(base + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      assert.equal(res.status, 202, "cheap empty scans must be accepted while finished jobs can be evicted");
      ids.push((await res.json()).id);
      for (let k = 0; k < 80; k++) {
        const j = await (await fetch(`${base}/api/jobs/${ids[i]}`)).json();
        if (j.status === "done" || j.status === "error") break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.equal((await fetch(`${base}/api/jobs/${ids[0]}`)).status, 404, "the oldest finished jobs must be evicted once the map is full");
    assert.equal((await fetch(`${base}/api/jobs/${ids[11]}`)).status, 200, "the newest jobs stay pollable");
  } finally {
    child.kill("SIGKILL");
  }
});

test("server: eviction respects a grace window — a fresh finished report cannot be stolen", async () => {
  const fake = await stubServer((msg) => (msg.method === "getSignaturesForAddress" ? { result: [] } : { result: null }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SOLANA_RPC: fake.url,
      STOCKBASIS_NO_FEATURED: "1",
      STOCKBASIS_NO_MARKET: "1",
      MAX_JOBS: "3",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.ok(await waitReady(base), "server did not come up");
  const addr = (tag) => ("A" + tag + "b".repeat(43 - tag.length)).slice(0, 44);
  const postFull = async (address) => {
    const res = await fetch(base + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
    return { code: res.status, id: (await res.json()).id };
  };
  const waitDone = async (id) => {
    for (let k = 0; k < 80; k++) {
      const j = await (await fetch(`${base}/api/jobs/${id}`)).json();
      if (j.status === "done" || j.status === "error") return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("job never finished");
  };
  try {
    const victim = await postFull(addr("Victim"));
    await waitDone(victim.id);
    for (const tag of ["F1", "F2"]) await waitDone((await postFull(addr(tag))).id); // map now full of fresh done-jobs
    const pressured = await postFull(addr("F3"));
    assert.equal(pressured.code, 503, "nothing evictable inside the grace window — the filler's own POST is refused");
    assert.equal((await fetch(`${base}/api/jobs/${victim.id}`)).status, 200, "the victim's just-finished result stays readable");
  } finally {
    child.kill("SIGKILL");
  }
});

test("stats: one upstream call per burst; an empty strip recovers quickly, not after the full window", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join("test", "fixtures", "stats-child.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STATS_EMPTY_TTL_MS: "400", SB_FIXTURE_SPAWNED: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  let first = null;
  for (let i = 0; i < 60 && !first; i++) {
    try { const r = await fetch(base + "/api/stats"); if (r.ok) first = await r.json(); } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(first, "server did not come up");
  try {
    // the child's market upstream answers throttled on the very first call:
    // an honest empty strip, briefly cached
    assert.equal(first.volume24hUsd, 0);
    await new Promise((r) => setTimeout(r, 700)); // past the short empty-strip TTL
    const burst = await Promise.all(Array.from({ length: 8 }, () => fetch(base + "/api/stats").then((r) => r.json())));
    assert.ok(burst.every((s) => s.volume24hUsd === 12345), "the strip must recover as soon as the upstream answers again");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((out.match(/DSCALL/g) ?? []).length, 2, "a burst shares one upstream call (1 throttled + 1 shared)");
  } finally {
    child.kill("SIGKILL");
  }
});

test("access log: every request journals one line, hostile headers cannot flood it", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join("test", "fixtures", "stats-child.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SB_FIXTURE_SPAWNED: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/")).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // control chars cannot reach the handler at all (llhttp rejects them before
  // the value lands in req.headers — the strip in sane() is defense-in-depth),
  // so the observable contract is the length cap and one line per request
  const hostile = "evil/1.0 " + "A".repeat(200);
  try {
    const r = await fetch(base + "/api/stats", { headers: { "user-agent": hostile, "x-forwarded-for": hostile } });
    assert.ok(r.ok);
    await new Promise((r) => setTimeout(r, 200));
    const access = out.split("\n").filter((l) => l.startsWith(`[stockbasis] GET /api/stats ua=`));
    assert.equal(access.length, 1, "exactly one access line per request");
    const ua = access[0].match(/ua="([^"]*)"/)[1];
    assert.equal(ua.length, 120, "the UA is capped at 120 chars");
    const xff = access[0].match(/ xff="([^"]*)"/);
    assert.ok(xff && xff[1].length === 120, "XFF is journaled under the same cap");
  } finally {
    child.kill("SIGKILL");
  }
});
