// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE A NODE'S OWN CHAIN VIEW COMES FROM: its bitcoind, over RPC.
//
// The committee seed is a Bitcoin block hash published after `committee_time`
// (5A.5, spec v4.6.2: the first block whose median-time-past is after it).
// `beaconFromChain` already says WHICH block that is, given headers. Until
// something reads a real chain, that rule is a function of headers somebody
// handed in - and "somebody handed in" is exactly the party the rule exists to
// keep away from the seed.
//
// THIS FILE DECIDES NOTHING. It fetches 80-byte headers and hands them to the
// rule. There is no second chooser here: no tip preference, no "close enough"
// window, no fallback to a cached answer. If bitcoind cannot be reached, this
// throws and the caller has no beacon - which is the honest state, and which
// 27 already turns into a refusal rather than an invented world.
//
// COOKIE AUTH, because that is what a local bitcoind writes and what a node
// operator does not have to configure. The cookie is read on every call rather
// than cached: bitcoind rewrites it on restart, and a client holding the old
// one would report "unauthorised" for a node that is perfectly healthy.
import { readFileSync } from 'node:fs';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { HEADER_BYTES, blockHashOf } from '../../arena-protocol/src/chain.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { timed } from './slow.js';

/** The most headers one call will ask for. A view is a window, not the chain. */
export const MAX_HEADERS = 2016;

export function bitcoindRpc({ url, cookiePath, fetcher = fetch, readCookie } = {}) {
  if (!url) throw new Error('a bitcoind rpc needs a url');
  // THE REFUSALS SAY WHAT HAPPENED, and this is why they are wrapped. Measured
  // against a real daemon: stopping bitcoind makes it delete its cookie, so an
  // unwrapped read failed with `ENOENT: no such file or directory` and a path -
  // true, useless, and indistinguishable from a typo in a config. A node with
  // no chain must say it has no chain.
  const cookie = readCookie || (() => {
    try { return readFileSync(cookiePath, 'utf8').trim(); }
    catch (e) {
      throw new Error(`no bitcoind cookie at ${cookiePath}: there is nothing to read a `
        + `chain from, and a beacon is not invented when one is missing (${e.code || e.message})`);
    }
  });

  // THE COOKIE KEPT, AND READ AGAIN WHEN BITCOIND REFUSES IT (measured on seat 3's start 2026-10-18: reading
  // the file on every call was 2.7 % of the main thread's first minute). bitcoind writes a new cookie at its restart, so a 401 -
  // or no cookie kept yet - reads the file again and asks once more; a cookie that is gone is said as before.
  let kept = null;
  const post = async (payload, what) => {
    const ask = async () => {
      if (kept === null) kept = cookie();
      try {
        return await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(kept).toString('base64')}` },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        throw new Error(`bitcoind at ${url} did not answer ${what}: ${e.message}`);
      }
    };
    let r = await ask();
    if (r.status === 401) { kept = null; r = await ask(); }
    const text = await r.text();
    if (!r.ok) throw new Error(`bitcoind answered ${r.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`bitcoind answered something that is not json: ${text.slice(0, 200)}`); }
  };
  const call = async function call(method, params = []) {
    const body = await post({ jsonrpc: '1.0', id: 'arena', method, params }, method);
    if (body.error) throw new Error(`bitcoind refused ${method}: ${body.error.message || body.error}`);
    return body.result;
  };
  // MANY CALLS IN ONE REQUEST (kanban #1968, measured 2026-11-12 on the testnet4 seats: a restarted seat named no committee for
  // 30-45 min. Its views of 105 view keys - census windows from 153,616 to the tip, ~7,100 blocks - and their beacons' header reads were
  // ~35,500 calls, each its own HTTP request through the seat's two bitcoind lanes (ARENA_FETCH_MAX_PER_ORIGIN=2), and on a busy seat a
  // request held its lane ~100 ms: ~20 calls a second, while bitcoind itself sat idle - 0.09 commands active on average). JSON-RPC's
  // batch: `requests` [[method, params], ...] in one request, the results in the same order; any refused call refuses the whole batch,
  // as the first refused call of a walk did.
  call.batch = async (requests) => {
    if (!requests.length) return [];
    const what = `${requests.length} calls (${requests[0][0]}...)`;
    const body = await post(requests.map(([method, params = []], id) => ({ jsonrpc: '1.0', id, method, params })), what);
    if (!Array.isArray(body)) throw new Error(`bitcoind answered ${what} with no batch: ${JSON.stringify(body).slice(0, 200)}`);
    const out = new Array(requests.length);
    const seen = new Set();
    for (const one of body) {
      const i = one && Number.isInteger(one.id) ? one.id : -1;
      if (i < 0 || i >= requests.length) throw new Error(`bitcoind answered a batch with an id it was not asked: ${JSON.stringify(one && one.id)}`);
      if (one.error) throw new Error(`bitcoind refused ${requests[i][0]}: ${one.error.message || one.error}`);
      out[i] = one.result; seen.add(i);
    }
    if (seen.size !== requests.length) throw new Error(`bitcoind answered ${seen.size} of the ${requests.length} calls of a batch`);
    return out;
  };
  return call;
}

/**
 * BLOCKS `from`..`to` AS THE CENSUS READS THEM: header plus transactions.
 *
 * The same shape `regtest-bond.mjs` hands a tool, asked of a node over RPC, so
 * a daemon started with nothing but the chain can derive a round's census -
 * and read each signer node's address out of the advertisement in its bond - the way
 * a first assignment does. The census checks the header links and merkle roots
 * itself; this only divides the bytes.
 */
// A HEIGHT'S HASH IS ASKED ONLY NEAR THE TOP OF A VIEW (measured on seat 3's start 2026-10-18: every census view
// asked bitcoind for all ~2,016 of its heights again, cached blocks or not - the chain RPC was 9 % of the main thread's first
// minute). Below DEEP_BLOCKS under the view's top the hash read once is kept (cache.hashAt); a reorganisation that deep is not
// followed by a kept hash - and the census checks the header links of every view itself, so a stale one is refused, not believed.
export const DEEP_BLOCKS = 24;
// AND THE TOP OF A VIEW IS KEPT WHILE THE CHAIN IS THE SAME CHAIN (kanban #587, measured 2026-10-23 on seat 7 three minutes after a
// restart: 931 getblockhash a second - the top 24 heights of every view asked again, views built for thousands of rounds - a third of
// the seat's start-up CPU and a core of bitcoind's): while bitcoind's best block hash is the one they were read under, every height's
// hash is unchanged, so they are kept under it and dropped when it moves. Each view asks the best hash once, at its start - views
// asking at the same moment share the one ask - so a view is exactly as current as its own per-height reads were; no answer is
// kept by time (a census is stored for days under its block hash, and must never be one of a branch the chain has left).
function bestOf(call, cache) {
  if (!cache.bestInFlight) {
    cache.bestInFlight = Promise.resolve(call('getbestblockhash', [])).finally(() => { cache.bestInFlight = null; });
  }
  return cache.bestInFlight;
}

// THE DEEP PART OF A VIEW, READ IN BATCHES BEFORE IT IS WALKED (kanban #1968): its heights' hashes HASH_BATCH to a request, then the
// blocks the cache does not hold, BLOCK_BATCH to a request (fewer once the blocks run large: about BLOCK_BATCH_BYTES of hex a request).
// A chunk of HASH_BATCH heights at a time, and a chunk another view is already reading is waited for, not asked again - views read at
// once walk the window together, one batch out at a time, as they shared one call per height before. The walk below then finds every
// deep height and block kept and asks bitcoind only for the top DEEP_BLOCKS heights, as before; the blocks and hashes are the same ones.
export const HASH_BATCH = 500;
export const BLOCK_BATCH = 32;
export const BLOCK_BATCH_BYTES = 16 * 1024 * 1024;
async function readDeepInBatches(call, from, to, cache) {
  const deepTo = to - DEEP_BLOCKS;
  let per = BLOCK_BATCH;
  for (let lo = from; lo <= deepTo; lo += HASH_BATCH) {
    const hi = Math.min(deepTo, lo + HASH_BATCH - 1);
    const need = [], waits = [];
    for (let h = lo; h <= hi; h++) {
      if (cache.hashes.get(h) !== undefined) continue;
      const fly = cache.hashInFlight.get(`d${h}`);
      if (fly) waits.push(fly); else need.push(h);
    }
    if (need.length) {
      const ask = Promise.resolve(call.batch(need.map((h) => ['getblockhash', [h]])));
      need.forEach((h, i) => {
        const p = ask.then((r) => { cache.putHash(h, r[i]); return r[i]; });
        cache.hashInFlight.set(`d${h}`, p);
        p.then(() => cache.hashInFlight.delete(`d${h}`), () => cache.hashInFlight.delete(`d${h}`));
        waits.push(p);
      });
    }
    await Promise.all(waits);
    const want = [], held = [];
    for (let h = lo; h <= hi; h++) {
      const hash = cache.hashes.get(h);
      if (hash === undefined || cache.get(hash)) continue;
      const fly = cache.inFlight.get(hash);
      if (fly) held.push(fly); else if (!want.includes(hash)) want.push(hash);
    }
    for (let i = 0; i < want.length;) {
      // another view may have taken some of these meanwhile: those are waited for, not read again
      const part = [];
      while (i < want.length && part.length < per) {
        const x = want[i++];
        if (cache.get(x)) continue;
        const fly = cache.inFlight.get(x);
        if (fly) held.push(fly); else part.push(x);
      }
      if (!part.length) continue;
      const ask = Promise.resolve(call.batch(part.map((x) => ['getblock', [x, 0]])));
      const each = part.map((x, k) => {
        const p = ask.then((r) => {
          const block = timed('chain block read', () => splitBlock(fromHex(r[k])), { over: 20 });
          cache.put(x, block);
          return block;
        });
        cache.inFlight.set(x, p);
        p.then(() => cache.inFlight.delete(x), () => cache.inFlight.delete(x));
        return p;
      });
      const answers = await ask;
      await Promise.all(each);
      const bytes = answers.reduce((n, a) => n + String(a).length, 0);
      per = Math.max(1, Math.min(BLOCK_BATCH, Math.floor(BLOCK_BATCH_BYTES / Math.max(1, bytes / part.length))));
    }
    await Promise.all(held);
  }
}

export async function blocksOver(call, from, to, { cache = null } = {}) {
  const blocks = [];
  // THE HASH EACH BLOCK WAS READ UNDER, height by height (kanban #2191, #1841): a caller that keys what it derives by a block's hash
  // checks the view's own block at that height came under that hash - not whether its cache happens to hold that block
  const hashes = [];
  let best = null;
  if (cache && cache.hashes && cache.hashInFlight && cache.inFlight && call && typeof call.batch === 'function') await readDeepInBatches(call, from, to, cache);
  for (let h = from; h <= to; h++) {
    const deep = cache && cache.hashes && h <= to - DEEP_BLOCKS;
    let top = !deep && cache && cache.topHashes;
    let hash = deep ? cache.hashes.get(h) : undefined;
    // a bitcoind that does not answer the best hash: this view asks its top heights as before
    if (top && best === null) { try { best = await bestOf(call, cache); } catch { best = false; } }
    if (best === false) top = false;
    if (top) {
      if (cache.topBest !== best) { cache.topHashes.clear(); cache.topBest = best; }
      hash = cache.topHashes.get(h);
    }
    if (hash === undefined) {
      // ONE ASK OF A HEIGHT IN FLIGHT, HOWEVER MANY VIEWS WALK IT AT ONCE (kanban #587, measured 2026-10-23 on seats 1, 5 and 7 after
      // a restart: 700-1,300 getblockhash a second for ~5 min, ~550 heights each asked ~119 times in 8 s - a starting seat reads
      // hundreds of views together, each walked the same heights, and each missed the empty cache on its own). As for blocks
      // (inFlight below): the second asker waits for the first. A height near a view's top is shared under the best hash it was
      // read for, so it stays exactly as current as its own ask.
      const fly = cache && cache.hashInFlight && (deep || top) ? (deep ? `d${h}` : `t${best}:${h}`) : null;
      let ask = fly ? cache.hashInFlight.get(fly) : undefined;
      if (!ask) {
        ask = Promise.resolve(call('getblockhash', [h]));
        if (fly) { cache.hashInFlight.set(fly, ask); ask.then(() => cache.hashInFlight.delete(fly), () => cache.hashInFlight.delete(fly)); }
      }
      hash = await ask;
      if (deep) cache.putHash(h, hash);
      else if (top && cache.topBest === best) cache.topHashes.set(h, hash);
    }
    hashes.push(String(hash));
    const had = cache ? cache.get(hash) : undefined;
    if (had) { blocks.push(had); continue; }
    // THE BLOCK, TURNED FROM HEX INTO BYTES, IS THIS THREAD'S WORK (2026-09-18 02:40: name the leftover). The
    // read itself waits on bitcoind; what runs here is the answer's continuation - a megabyte of hex parsed and split -
    // and it lands on the thread that draws the other players' trucks.
    // ONE READ OF A BLOCK IN FLIGHT, HOWEVER MANY VIEWS ASK FOR IT AT ONCE (2026-10-15: "Do everything you can to
    // lower the load"; measured on a testnet4 seat's heap: 96,494 parsed blocks, 1,004,407 transactions, 940 MB, for views
    // that span about 2,600 distinct blocks). The 8 s grids make a view per round, and their views are read together: every
    // one of them missed the cache for the same block while the first read was still out, parsed its own copy and kept it -
    // tens of copies of each block. A read in flight is now shared: the second asker waits for the first and holds its object.
    const read = () => call('getblock', [hash, 0]).then((answer) => {
      const block = timed('chain block read', () => splitBlock(fromHex(answer)), { over: 20 });
      if (cache) cache.put(hash, block);
      return block;
    });
    let block;
    if (cache && cache.inFlight) {
      let p = cache.inFlight.get(hash);
      if (!p) { p = read(); cache.inFlight.set(hash, p); p.then(() => cache.inFlight.delete(hash), () => cache.inFlight.delete(hash)); }
      block = await p;
    } else block = await read();
    blocks.push(block);
  }
  const view = { blocks, firstHeight: from };
  Object.defineProperty(view, 'hashes', { value: hashes, enumerable: false });
  return view;
}

/**
 * ONE COPY OF A BLOCK, HOWEVER MANY VIEWS HOLD IT (2026-10-02: "Continue with 1" - the free pair's two nodes held
 * 3.8 GB each). Every free round names its own committee_time, so every round got its own ~2,000-block view, read from
 * bitcoind and kept: 2,511 rounds, 2,511 view keys over 19 census heights - the same blocks, parsed again, once per round,
 * and never let go. Keyed by the block's hash, so a reorganised chain is new blocks, never a stale answer; the oldest
 * kept are dropped past `max`. A view still holds the blocks it read - this only stops two views holding two copies.
 */
export function blockCache({ max = 50000 } = {}) {
  const kept = new Map();
  const hashes = new Map();                  // height -> hash, for heights deep under the views that read them (blocksOver)
  return {
    inFlight: new Map(),                     // block hash -> the read of it still out (blocksOver)
    get: (hash) => kept.get(hash),
    put: (hash, block) => {
      kept.set(hash, block);
      if (kept.size > max) kept.delete(kept.keys().next().value);
    },
    hashes,
    topHashes: new Map(),                    // height -> hash near the views' tops, valid while topBest is bitcoind's best (blocksOver)
    topBest: null, bestInFlight: null,
    hashInFlight: new Map(),                 // `d<height>` / `t<best>:<height>` -> the getblockhash still out (blocksOver)
    putHash: (height, hash) => {
      hashes.set(height, hash);
      if (hashes.size > max) hashes.delete(hashes.keys().next().value);
    },
    get size() { return kept.size; },
  };
}

/**
 * `count` headers ending at the tip, in height order, as Bitcoin's own bytes.
 *
 * The window is the caller's and the answer is the chain's: this reads the
 * height once and then walks it, so a chain that grows during the read cannot
 * hand back a list with a hole in it - the heights are consecutive by
 * construction and `chainWork` checks they link.
 */
/**
 * HEADERS FORWARD FROM A HEIGHT: `count` headers from `from`, or up to the tip if that is nearer. The
 * beacon of a round whose committee_time lies further back than a tip window reaches is read from the round's own
 * census height on, which comes before it (§5A.5: census cut = start - 36 h, committee_time = start - 24 h).
 */
export async function headersFrom(call, { from, count } = {}) {
  if (!Number.isInteger(from) || from < 0) return Promise.reject(new Error('a header range starts at a height'));
  if (!Number.isInteger(count) || count < 1) return Promise.reject(new Error('a header range is at least one block'));
  if (count > MAX_HEADERS)
    return Promise.reject(new Error(`a range of ${count} is more than the ${MAX_HEADERS} this asks for at once`));
  const tip = Number(await call('getblockcount'));
  if (!Number.isInteger(tip) || tip < 0) throw new Error('bitcoind gave no block count');
  if (from > tip) throw new Error(`a range from ${from} starts past the tip ${tip}`);
  const to = Math.min(tip, from + count - 1);
  return { headers: await headersOver(call, from, to), firstHeight: from, tipHeight: to };
}

// THE HEADERS OF HEIGHTS from..to: height by height, or HASH_BATCH heights to a request where the call batches (kanban #1968: a beacon
// behind the tip window read its 2,016 headers as 4,032 calls, once per committee_time - 59 % of a restarted seat's calls)
async function headersOver(call, from, to) {
  const headers = [];
  const take = (h, hex) => {
    const bytes = fromHex(hex);
    if (bytes.length !== HEADER_BYTES) throw new Error(`block ${h} came back as ${bytes.length} bytes, not a header`);
    headers.push(bytes);
  };
  if (call && typeof call.batch === 'function') {
    for (let lo = from; lo <= to; lo += HASH_BATCH) {
      const hi = Math.min(to, lo + HASH_BATCH - 1);
      const heights = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      const hashes = await call.batch(heights.map((h) => ['getblockhash', [h]]));
      const hexes = await call.batch(hashes.map((x) => ['getblockheader', [x, false]]));
      heights.forEach((h, i) => take(h, hexes[i]));
    }
    return headers;
  }
  for (let h = from; h <= to; h++) take(h, await call('getblockheader', [await call('getblockhash', [h]), false]));
  return headers;
}

export async function headersToTip(call, { count } = {}) {
  if (!Number.isInteger(count) || count < 1)
    return Promise.reject(new Error('a header window is at least one block'));
  if (count > MAX_HEADERS)
    return Promise.reject(new Error(`a window of ${count} is more than the ${MAX_HEADERS} this asks for at once`));

  const tip = Number(await call('getblockcount'));
  if (!Number.isInteger(tip) || tip < 0) throw new Error('bitcoind gave no block count');
  const firstHeight = Math.max(0, tip - count + 1);
  return { headers: await headersOver(call, firstHeight, tip), firstHeight, tipHeight: tip };
}

/**
 * A CENSUS FROM A VIEW, READ ONCE MORE WITH FRESH HASHES WHEN IT IS NOT A CHAIN (kanban #495, measured 2026-10-21 on the three installer
 * nodes: every founding census since 157,115 failed "that is not a chain: this header does not follow the one before it" - blocksOver keeps
 * a height's hash once it is DEEP_BLOCKS under a read's top, and one kept while the node followed another branch was never read again).
 * `read()` the view (blocksOver with `cache`), `derive(view)` the census of it. Answers the census; on "not a chain" the cache's kept
 * hashes are dropped and the view is read and derived once more.
 */
export async function censusWithFreshHashes({ read, derive, cache }) {
  let census = derive(await read());
  if (!census.ok && /not a chain/.test(String(census.why)) && cache && cache.hashes && cache.hashes.size) {
    cache.hashes.clear(); if (cache.topHashes) cache.topHashes.clear();
    census = derive(await read());
  }
  return census;
}


/** Does every block of a view (blocksOver's answer) name the block before it? The link check alone - no work, no merkle roots. */
export function viewLinks(view) {
  const blocks = (view && view.blocks) || [];
  for (let i = 1; i < blocks.length; i++) {
    const prev = blockHashOf(blocks[i - 1].header), named = blocks[i].header.subarray(4, 36);
    for (let k = 0; k < 32; k++) if (prev[k] !== named[k]) return false;
  }
  return true;
}

/**
 * A ROUND'S VIEW, READ ONCE MORE WITH FRESH HASHES WHEN IT DOES NOT LINK (kanban #576, measured 2026-10-21 ~22:00Z on node-15: its
 * rounds' views all failed "that is not a chain: this header does not follow the one before it" - a height's hash kept while the node
 * followed another branch, as censusWithFreshHashes found for the founding census - so no round was ever assigned, and the series
 * writer asked again on every turn of the loop: 100 % of a core, its loop held ~155 ms thousands of times). The views of rounds were
 * read without that repair. `read()` the view (blocksOver with `cache`); a view that does not link drops the cache's kept hashes and
 * is read once more.
 */
export async function viewWithFreshHashes({ read, cache }) {
  let view = await read();
  if (cache && cache.hashes && cache.hashes.size && !viewLinks(view)) {
    cache.hashes.clear(); if (cache.topHashes) cache.topHashes.clear();
    view = await read();
  }
  return view;
}
