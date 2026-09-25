// A 200 answer with EMPTY tags (Jupiter knows the token but has not indexed
// its tags yet — the same listing lag as a no-data answer) used to be cached
// forever as a definitive non-stock: every trade of that ticker then stayed
// invisible to trades, transfers and reconcile until a process restart.
// Only answers that carry tags are immutable; a tagless one must expire.

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const LAG = "TagLagMint1111111111111111111111111111111111111"; // tagless first, tagged later
const TAGGED = "TaggedMint11111111111111111111111111111111111"; // tagged from the first ask
const MEME = "MemeMint111111111111111111111111111111111111111"; // non-stock, but non-empty tags

const hits = { lag: 0, tagged: 0, meme: 0 };
let lagTagged = false;
const jup = http.createServer((req, res) => {
  const q = new URL(req.url, "http://localhost").searchParams.get("query") ?? "";
  res.writeHead(200, { "Content-Type": "application/json" });
  if (q === LAG) {
    hits.lag++;
    res.end(JSON.stringify([{
      id: LAG, symbol: "LAGx", name: "Tag Lag",
      tags: lagTagged ? ["stocks"] : [],
    }]));
  } else if (q === TAGGED) {
    hits.tagged++;
    res.end(JSON.stringify([{ id: TAGGED, symbol: "TAGx", name: "Tagged", tags: ["stocks"] }]));
  } else if (q === MEME) {
    hits.meme++;
    res.end(JSON.stringify([{ id: MEME, symbol: "MEMEx", name: "Meme", tags: ["memes"] }]));
  } else {
    res.end("[]");
  }
});
await new Promise((r) => jup.listen(0, "127.0.0.1", r));
process.env.JUP_SEARCH_URL = `http://127.0.0.1:${jup.address().port}/search`;
// short enough that the expiry retry is testable in seconds, long enough to
// outlive the 250ms politeness sleep that follows every fresh fetch
process.env.CLASSIFY_TAGLESS_TTL_MS = "1000";

const { lookupToken } = await import("../src/classify.mjs");

after(() => { jup.closeAllConnections?.(); jup.close(); });

test("classify: a tagless answer is provisional — re-asked after the TTL, the stock surfaces without a restart", async () => {
  const first = await lookupToken(LAG);
  assert.ok(first, "a 200 with the token found is metadata, not a no-data null");
  assert.equal(first.isStock, false); // tags not indexed yet: non-stock for now
  assert.deepEqual(first.tags, []);

  const second = await lookupToken(LAG); // within the TTL: cached, no re-ask
  assert.equal(second.isStock, false);
  assert.equal(hits.lag, 1);

  lagTagged = true; // Jupiter finishes indexing the tag
  await new Promise((r) => setTimeout(r, 1100)); // the tagless answer expires
  const third = await lookupToken(LAG); // same process — no restart involved
  assert.equal(third.isStock, true, "the freshly indexed tag must be picked up");
  assert.equal(third.symbol, "LAGx");
  assert.equal(hits.lag, 2, "the expired tagless answer must re-ask Jupiter");
});

test("classify: a tagged answer is still immutable — cached past the TTL, no re-ask", async () => {
  const first = await lookupToken(TAGGED);
  assert.equal(first.isStock, true);
  await new Promise((r) => setTimeout(r, 1100)); // well past the tagless TTL
  const again = await lookupToken(TAGGED);
  assert.equal(again.isStock, true);
  assert.equal(hits.tagged, 1, "a definitive answer must not re-hit Jupiter");
});

test("classify: a definitively non-stock answer (non-empty tags) is still cached forever", async () => {
  const first = await lookupToken(MEME);
  assert.equal(first.isStock, false);
  assert.deepEqual(first.tags, ["memes"]);
  await new Promise((r) => setTimeout(r, 1100));
  const again = await lookupToken(MEME);
  assert.equal(again.isStock, false);
  assert.equal(hits.meme, 1, "a deliberately untagged-as-stock token must not re-hit Jupiter");
});
