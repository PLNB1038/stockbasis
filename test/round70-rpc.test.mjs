// Regression tests for review round 70 (rpc rotation budget). Every test pins one proven vector:
//   rpc: -32020 rotations must not spend the 429/5xx retry budget — three
//        data holes plus one recovering throttled mirror used to burn past
//        MAX_RETRIES on rotations alone and kill the whole call (and the
//        scan) having seen a single real 429
//   rpc: a mirror already known to hole this call is not re-asked on every
//        rotation step — repeat asks burn hole-rotation slots for a
//        guaranteed repeat answer
//   rpc: the retry budget still caps honestly when mirrors keep answering 429

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.RPC_MAX_RETRIES ??= "2"; // keeps the backoff sleeps short (750ms + 1500ms)
process.env.RPC_MIN_INTERVAL_MS ??= "0"; // pacing must not add noise between rotations

const { rpc } = await import("../src/rpc.mjs");

const servers = [];
const stubServer = (handler) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body || "{}"), req, res);
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
});

const HOLE = { error: { code: -32020, message: "Transaction not found" } };

test("rpc: -32020 rotations do not spend the 429 retry budget — a throttled mirror that recovers still answers", async () => {
  const asked = { holes: [0, 0, 0], throttle: 0 };
  const holeMirror = (i) => (msg) => { asked.holes[i]++; return HOLE; };
  const a = await stubServer(holeMirror(0));
  const b = await stubServer(holeMirror(1));
  const c = await stubServer(holeMirror(2));
  // the only mirror holding the tx throttles its first two hits, then serves.
  // Three mirrors answer -32020 for this tx (partial eviction): under one
  // shared attempt counter the hole rotations alone walked past MAX_RETRIES
  // and the call died as "HTTP 429 after N attempts" having seen ONE real 429
  const d = await stubServer((msg, req, res) => {
    asked.throttle++;
    if (asked.throttle <= 2) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { slot: 1, sig: msg.params[0] } }));
  });

  const tx = await rpc("getTransaction", ["sig", {}], { rpcUrl: `${a.url},${b.url},${c.url},${d.url}` });
  assert.ok(tx, "the call must resolve with the transaction once the throttled mirror recovers");
  assert.equal(tx.sig, "sig");
  assert.equal(asked.throttle, 3, "two honest 429s then the answer — exactly the retry budget, rotations excluded");
  asked.holes.forEach((n, i) => {
    assert.ok(n >= 1, `hole mirror ${i} must genuinely answer -32020 before its hole counts`);
    assert.ok(n <= 2, `hole mirror ${i} must not be re-asked on every rotation step (asked ${n} times)`);
  });
});

test("rpc: the retry budget still caps honestly when every mirror keeps throttling", async () => {
  const hits = [];
  const throttle = (name) => (msg, req, res) => { hits.push(name); res.writeHead(429); res.end(); };
  const a = await stubServer(throttle("a"));
  const b = await stubServer(throttle("b"));
  const c = await stubServer(throttle("c"));
  await assert.rejects(
    rpc("getSignaturesForAddress", ["Aaaa1111111111111111111111111111111111111111", { limit: 10 }], { rpcUrl: `${a.url},${b.url},${c.url}` }),
    (e) => /HTTP 429 after 3 attempts/.test(e.message),
  );
  // MAX_RETRIES=2 → exactly three real throttled answers (initial + two
  // retries): rotations between mirrors are free, throttled answers are not
  assert.equal(hits.length, 3, `exactly three throttled answers may happen (got ${hits.length})`);
});
