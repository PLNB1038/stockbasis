// Token metadata is attacker-controllable: bidi and zero-width format
// characters must be stripped at the source, or a spoofed symbol renders
// indistinguishably from a real ticker next to real money (UI and CSV).

import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const jup = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify([{ id: "S", symbol: "NVDAx\u202E", name: "Totally Not NVIDIA\u200B", tags: ["stocks"] }]));
});
await new Promise((r) => jup.listen(0, "127.0.0.1", r));
process.env.JUP_SEARCH_URL = `http://127.0.0.1:${jup.address().port}/search`;

const { lookupToken } = await import("../src/classify.mjs");

test("metadata: bidi and zero-width format characters never reach a symbol", async () => {
  const meta = await lookupToken("S");
  assert.equal(meta.symbol, "NVDAx", "the RTL override must be stripped");
  assert.equal(meta.name, "Totally Not NVIDIA", "the zero-width space must be stripped");
  assert.equal(meta.isStock, true);
});

after(() => { jup.closeAllConnections?.(); jup.close(); });
