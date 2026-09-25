// Solana JSON-RPC client: global pacing, backoff, endpoint rotation on 429/5xx.

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com";
// finite-or-default like every other env number: a typo ("5x") parses to NaN
// and NaN comparisons are always false — the retry cap would never trigger
// and one throttled mirror would wedge the serialized queue forever; an
// empty string parses to 0 and kills rotation on the first 429 instead.
// (Local copy: importing the shared helper from ingest.mjs would be a cycle.)
const envInt = (v, dflt) => {
  if (v == null || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const MIN_INTERVAL_MS = envInt(process.env.RPC_MIN_INTERVAL_MS, 120);
const MAX_RETRIES = envInt(process.env.RPC_MAX_RETRIES, 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON-RPC request-class errors are the caller's own fault — a wrong-size
// pubkey or a malformed filter answers -32602 on every mirror forever.
// Retrying them just burns pacing slots and backoff sleeps while holding the
// caller's slot.
const PERMANENT_RPC_CODES = new Set([-32600, -32601, -32602, -32700]);

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
  // comma-separated list → on repeated 429/5xx we rotate to the next mirror.
  // Duplicates are removed: with the same URL listed twice, one "not found"
  // answer can never fill two holes and the rotation below would spin forever.
  // An EMPTY override is "no override": || keeps it falling through to the
  // default list instead of fetching the literal string "" (parse failure)
  const raw = opts.rpcUrl || process.env.SOLANA_RPC || DEFAULT_RPC;
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
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
// serialize PER ENDPOINT: each mirror keeps its own chain so its pacing slot
// is honored, but one slow mirror must not stall calls addressed to a healthy
// one. A single global chain made every concurrent scan queue head-to-tail
// behind the slowest request in the system (precompute and jury traffic
// included) while the rate limiter itself was already per-mirror.
const rpcChains = new Map(); // url -> tail of that endpoint's serialized chain
const enqueueRpc = (url, fn) => {
  const run = (rpcChains.get(url) ?? Promise.resolve()).then(fn, fn);
  rpcChains.set(url, run.catch(() => {}));
  return run;
};

export function rpc(method, params, opts = {}) {
  return rpcInner(method, params, opts);
}

async function rpcInner(method, params, opts = {}) {
  const signal = opts.signal;
  const urls = endpoints(opts);
  // endpoints that answered -32020 ("not found") for THIS call: a public mirror
  // lacking old transactions is a per-endpoint data hole, not a chain fact —
  // only when every endpoint says "not found" may the caller treat it as real
  const holes = new Set();
  // TWO separate budgets. retries counts honest transient faults (429/5xx, a
  // broken envelope, a transient RPC error) and alone is capped by
  // MAX_RETRIES; holeSkips caps the -32020/null-result rotation itself.
  // attempt once served both, so every hole rotation burned retry budget:
  // with >=3 mirrors and a partially evicted tx, the rotations alone walked
  // past MAX_RETRIES and the first real 429 killed the whole call (fetchTx
  // escalates that to a failed scan) — the throttled mirror never got the
  // chances the retry budget promised it
  let retries = 0;
  let holeSkips = 0;
  // step the shared index to the next mirror that has NOT already holed this
  // call: re-asking a mirror that answered -32020/null burns a request and a
  // rotation slot for a guaranteed repeat answer. The skip is safe to loop:
  // advance() is only reachable while holes.size < urls.length (the hole
  // branches throw before every mirror is holed), so an unholed mirror always
  // exists within one lap. The holes set is per-call, so the skip is too —
  // and the url that answers is still credited via holes.add(url) below,
  // never via urls[endpointIdx], which a concurrent caller may have rotated
  // before we read it
  const advance = () => {
    endpointIdx++;
    while (holes.has(urls[endpointIdx % urls.length])) endpointIdx++;
  };

  for (;;) {
    if (signal?.aborted) throw new Error(`RPC ${method}: aborted`);
    const url = urls[endpointIdx % urls.length];
    // the fetch (and its per-endpoint pacing wait) runs inside that endpoint's
    // chain: concurrent callers to the same mirror stay paced and ordered,
    // while callers to a different mirror proceed in parallel
    const res = await enqueueRpc(url, async () => {
      const wait = (lastCallByUrl.get(url) ?? 0) + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallByUrl.set(url, Date.now());
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
    });

    if (res.status === 429 || res.status >= 500) {
      if (retries >= MAX_RETRIES) throw new Error(`RPC ${method}: HTTP ${res.status} after ${retries + 1} attempts`);
      await sleep(2 ** Math.min(retries, 4) * 750);
      retries++; // only real throttled answers spend the retry budget — rotations are free
      advance(); // next attempt tries the next mirror in the list
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);

    const body = await res.json();
    // a 200-OK body with neither result nor error is a broken gateway answer,
    // not an empty success: returning undefined here would read as "no data,
    // all clean" to every caller. Rotate and retry like any transient fault.
    if (body?.result === undefined && body?.error === undefined) {
      if (retries >= MAX_RETRIES) throw new Error(`RPC ${method}: HTTP 200 without a JSON-RPC envelope after ${retries + 1} attempts`);
      await sleep(2 ** Math.min(retries, 4) * 750);
      retries++;
      advance();
      continue;
    }
    if (body.error) {
      // -32020 "transaction not found": try the remaining mirrors first —
      // the primary usually still serves what a shallow mirror has dropped
      if (body.error.code === -32020) {
        // credit the hole to the url that actually answered THIS call, never
        // to urls[endpointIdx] — a concurrent caller rotates the shared index,
        // and a url read from it may have never been asked about this request
        holes.add(url);
        // rotate while unvisited mirrors remain, under this branch's own
        // budget (a concurrent caller moves the shared index — the cap only
        // stops us from circling holed mirrors forever); these moves are
        // free — the retry budget above is never touched
        if (holes.size < urls.length && holeSkips++ < urls.length * 3) {
          advance();
          continue;
        }
        if (holes.size < urls.length) {
          // budget gone with holes unfilled: this is NOT a confirmed hole —
          // throw a transient error so the scan fails honestly instead of
          // silently treating unasked mirrors as agreeing
          throw new Error(`RPC ${method}: -32020 rotation exhausted before every mirror answered (${holes.size}/${urls.length} asked)`);
        }
        throw new RpcError(method, body.error);
      }
      // -32602 "invalid params" is permanent only about the MIRROR that said
      // it: a legacy provider that does not know maxSupportedTransactionVersion
      // rejects the very request a modern sibling serves fine. Rotate through
      // unasked mirrors before declaring the request itself unsendable
      if (body.error.code === -32602) {
        holes.add(url);
        if (holes.size < urls.length && holeSkips++ < urls.length * 3) {
          advance();
          continue;
        }
        throw new RpcError(method, body.error); // every mirror rejects the params — genuinely our request's fault
      }
      // request-class errors are permanent — fail now, not after six retries
      if (PERMANENT_RPC_CODES.has(body.error.code)) throw new RpcError(method, body.error);
      // other RPC-level errors can be transient (node behind a load balancer)
      if (retries >= MAX_RETRIES) throw new RpcError(method, body.error);
      await sleep(2 ** Math.min(retries, 4) * 750);
      retries++;
      advance();
      continue;
    }
    // result:null is the official "not found" answer (an evicted transaction
    // answers exactly this on mainnet): one mirror's null is a per-endpoint
    // data hole, not a chain fact — rotate exactly like -32020 before
    // returning it to the caller
    if (body.result === null) {
      holes.add(url);
      if (holes.size < urls.length && holeSkips++ < urls.length * 3) {
        advance();
        continue;
      }
      if (holes.size < urls.length) {
        throw new Error(`RPC ${method}: null-result rotation exhausted before every mirror answered (${holes.size}/${urls.length} asked)`);
      }
      opts.onEndpoint?.(url); // every mirror said null — the caller sees the honest null
      return body.result;
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
  // dedupe by signature: a mirror serving overlapping pages (an inclusive
  // before, or the next page answered by a different mirror after rotation)
  // must not double-yield a boundary signature — the caller books each tx
  // exactly once, and a duplicate would silently double every trade in it
  const seen = new Set();
  for (;;) {
    const params = [address, { limit: 1000 }];
    if (before) params[1].before = before;
    if (opts.until) params[1].until = opts.until;

    let answeredBy; // the mirror behind this page — excluded from its own cross-check
    let batch;
    try {
      batch = await rpc("getSignaturesForAddress", params, { ...opts, onEndpoint: (u) => { answeredBy = u; } });
    } catch (e) {
      if (e instanceof RpcError && e.code === -32020) return; // history ends at this node's depth — fine
      throw e;
    }
    if (!Array.isArray(batch) || !batch.length) {
      // a mirror's word for "history ends here" — an empty page, or a 200-OK
      // whose result is not even a list — is not trusted alone: one 429 can
      // rotate this call onto a shallow mirror whose empty answer would end
      // the walk on a silently truncated past. Demand agreement from a mirror
      // that did not just serve this answer (the rule reconcile applies to
      // empty balances); a single-mirror setup has nobody to ask and keeps
      // trusting itself, exactly like reconcile
      const { current, others } = rpcEndpoints(opts);
      const verify = (answeredBy ? [current, ...others] : others).filter((u) => u !== answeredBy);
      if (!verify.length) return;
      const confirm = await rpc("getSignaturesForAddress", params, { ...opts, rpcUrl: verify.join(","), onEndpoint: () => {} }).catch(() => null);
      if (confirm === null) {
        // nobody could confirm the end: an unconfirmed end is a hole in the
        // history — fail the scan honestly instead of quietly building a
        // report on a truncated past
        throw new Error("RPC getSignaturesForAddress: end-of-history answer could not be cross-checked");
      }
      if (!Array.isArray(confirm)) {
        // a 200-OK without a real list is not agreement with "empty" either
        throw new Error("RPC getSignaturesForAddress: cross-check answered a non-list");
      }
      if (!confirm.length) return; // both sides agree: the history truly ends
      batch = confirm; // the first mirror lied about the end — keep walking with the real page
    }

    // batches come newest-first; walk to the oldest of this batch, then
    // continue. A short page is NOT the end: the JSON-RPC contract is "at
    // most limit", so a provider capping pages well below 1000 with plenty
    // of history left must not silently truncate the walk — only an empty
    // page ends it. A cursor that refuses to advance (a mirror repeating
    // one page for any before) must not loop forever or re-yield it either.
    const next = batch[batch.length - 1].signature;
    if (next === before) return;
    for (const s of batch) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      yield { signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err };
    }
    before = next;
  }
}
