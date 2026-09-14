// Solana JSON-RPC client: global pacing, backoff, endpoint rotation on 429/5xx.

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com";
const MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS ?? 120);
const MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES ?? 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RPC-level error with the JSON-RPC code attached, so callers can react to specific codes. */
export class RpcError extends Error {
  constructor(method, body) {
    super(`RPC ${method}: ${JSON.stringify(body)}`);
    this.code = body?.code;
    this.name = "RpcError";
  }
}

const lastCallByUrl = new Map(); // endpoint URL -> ms of its last call start: pacing is per mirror
let endpointIdx = 0;

function endpoints(opts) {
  // comma-separated list → on repeated 429/5xx we rotate to the next mirror
  const raw = opts.rpcUrl ?? process.env.SOLANA_RPC ?? DEFAULT_RPC;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The endpoint the next paced call will hit, plus every other endpoint —
 * for callers that need to cross-check an answer against a mirror that
 * did NOT just serve it (an empty-but-200 answer is one mirror's word).
 */
export function rpcEndpoints(opts = {}) {
  const urls = endpoints(opts);
  const current = urls[endpointIdx % urls.length];
  return { current, others: urls.filter((u) => u !== current) };
}

/**
 * Call a Solana JSON-RPC method.
 * @param {string} method
 * @param {unknown[]} params
 * @param {{rpcUrl?: string, signal?: AbortSignal, onEndpoint?: (url: string) => void}} [opts]
 *   signal: aborts the call (a timed-out scan must free its RPC slots, not
 *   keep burning the shared queue as a zombie). onEndpoint: fired with the
 *   URL that produced the returned answer, for cross-endpoint verification.
 * @returns {Promise<any>} result field of the response
 */
let rpcQueue = Promise.resolve();

export function rpc(method, params, opts = {}) {
  // serialize: every call reserves the next pacing slot, so concurrent
  // callers cannot burst past the rate limit
  const run = rpcQueue.then(() => rpcInner(method, params, opts));
  rpcQueue = run.catch(() => {});
  return run;
}

async function rpcInner(method, params, opts = {}) {
  const signal = opts.signal;
  const urls = endpoints(opts);
  // endpoints that answered -32020 ("not found") for THIS call: a public mirror
  // lacking old transactions is a per-endpoint data hole, not a chain fact —
  // only when every endpoint says "not found" may the caller treat it as real
  const holes = new Set();

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error(`RPC ${method}: aborted`);
    const url = urls[endpointIdx % urls.length];
    // pace per endpoint: a background scan hammering public mirrors must not
    // eat the pacing budget of an interactive call to a different mirror
    const wait = (lastCallByUrl.get(url) ?? 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallByUrl.set(url, Date.now());

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`RPC ${method}: HTTP ${res.status} after ${attempt + 1} attempts`);
      endpointIdx++; // next attempt tries the next mirror in the list
      await sleep(2 ** Math.min(attempt, 4) * 750);
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);

    const body = await res.json();
    if (body.error) {
      // -32020 "transaction not found": try the remaining mirrors first —
      // the primary usually still serves what a shallow mirror has dropped
      if (body.error.code === -32020) {
        holes.add(urls[endpointIdx % urls.length]);
        if (holes.size < urls.length) {
          endpointIdx++;
          continue;
        }
        throw new RpcError(method, body.error);
      }
      // other RPC-level errors can be transient (node behind a load balancer)
      if (attempt >= MAX_RETRIES) throw new RpcError(method, body.error);
      endpointIdx++;
      await sleep(2 ** Math.min(attempt, 4) * 750);
      continue;
    }
    opts.onEndpoint?.(url); // the mirror this answer came from
    return body.result;
  }
}

/**
 * Fetch all signatures for an address, newest-first.
 * @param {string} address
 * @param {{rpcUrl?: string, before?: string, until?: string}} [opts]
 */
export async function* allSignatures(address, opts = {}) {
  let before = opts.before;
  for (;;) {
    const params = [address, { limit: 1000 }];
    if (before) params[1].before = before;
    if (opts.until) params[1].until = opts.until;

    let batch;
    try {
      batch = await rpc("getSignaturesForAddress", params, opts);
    } catch (e) {
      if (e instanceof RpcError && e.code === -32020) return; // history ends at this node's depth — fine
      throw e;
    }
    if (!batch?.length) return;

    // batches come newest-first; walk to the oldest of this batch, then continue
    before = batch[batch.length - 1].signature;
    for (const s of batch) {
      yield { signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err };
    }
    if (batch.length < 1000) return;
  }
}
