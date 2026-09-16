// Test helper for test/lifecycle.test.mjs: the real server module with the
// market-stats upstream faked. DS_MODE picks the scenario:
//   throttle — the first DexScreener call answers 429, every later one healthy
//   proto    — a pair whose baseToken.address is "__proto__" plus a healthy one
//   nan      — a healthy pair plus one with a non-numeric volume field
//   sort     — six pairs, the highest-volume one LAST in the response
// Never run directly.
import { readFileSync } from "node:fs";

// the test runner treats every .mjs under test/ as a test file, including
// this helper: run that way it would import a server that never exits and
// hang the whole run with no timeout and no output. A real spawn (from
// lifecycle.test.mjs / round67.test.mjs) sets SB_FIXTURE_SPAWNED; anything
// else must exit at once so a plain `npm test` stays runnable.
if (process.env.SB_FIXTURE_SPAWNED !== "1") {
  console.log("stats-child is a spawned fixture, not a test - exiting");
  process.exit(0);
}

const stocks = JSON.parse(readFileSync(new URL("../../data/stocks.json", import.meta.url), "utf8"));
const mints = Object.keys(stocks);
let dsCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  if (String(url).includes("api.dexscreener.com")) {
    dsCalls++;
    console.log(`DSCALL ${dsCalls}`);
    const mode = process.env.DS_MODE ?? "throttle";
    if (mode === "throttle" && dsCalls === 1) return Promise.resolve({ ok: false, status: 429 });
    const pairs = mode === "proto"
      ? [
          { baseToken: { address: "__proto__" }, priceUsd: 1, liquidity: { usd: 5 }, volume: { h24: 999_999_999 } },
          { baseToken: { address: mints[0] }, priceUsd: 2.5, liquidity: { usd: 9000 }, volume: { h24: 12345 } },
        ]
      : mode === "nan"
        ? [
            { baseToken: { address: mints[0] }, priceUsd: 2.5, liquidity: { usd: 9000 }, volume: { h24: 12345 } },
            { baseToken: { address: mints[1] }, priceUsd: 3, liquidity: { usd: 8000 }, volume: { h24: "lots" } },
          ]
        : mode === "sort"
          ? [
              ...mints.slice(0, 5).map((m, i) => ({ baseToken: { address: m }, priceUsd: 2, liquidity: { usd: 9000 - i }, volume: { h24: 1000 + i } })),
              { baseToken: { address: mints[5] }, priceUsd: 2, liquidity: { usd: 1 }, volume: { h24: 9_000_000 } },
            ]
          : [{ baseToken: { address: mints[0] }, priceUsd: 2.5, liquidity: { usd: 9000 }, volume: { h24: 12345 } }];
    return Promise.resolve({ ok: true, json: async () => pairs });
  }
  return realFetch(url, opts);
};
process.env.STOCKBASIS_NO_FEATURED = "1";
await import("../../src/server.mjs");
