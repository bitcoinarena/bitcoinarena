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
import { HEADER_BYTES } from '../../arena-protocol/src/chain.js';
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
  return async function call(method, params = []) {
    const ask = async () => {
      if (kept === null) kept = cookie();
      try {
        return await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(kept).toString('base64')}` },
          body: JSON.stringify({ jsonrpc: '1.0', id: 'blwp', method, params }),
        });
      } catch (e) {
        throw new Error(`bitcoind at ${url} did not answer ${method}: ${e.message}`);
      }
    };
    let r = await ask();
    if (r.status === 401) { kept = null; r = await ask(); }
    const text = await r.text();
    if (!r.ok) throw new Error(`bitcoind answered ${r.status}: ${text.slice(0, 200)}`);
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`bitcoind answered something that is not json: ${text.slice(0, 200)}`); }
    if (body.error) throw new Error(`bitcoind refused ${method}: ${body.error.message || body.error}`);
    return body.result;
  };
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

export async function blocksOver(call, from, to, { cache = null } = {}) {
  const blocks = [];
  for (let h = from; h <= to; h++) {
    const deep = cache && cache.hashes && h <= to - DEEP_BLOCKS;
    let hash = deep ? cache.hashes.get(h) : undefined;
    if (hash === undefined) {
      hash = await call('getblockhash', [h]);
      if (deep) cache.putHash(h, hash);
    }
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
  return { blocks, firstHeight: from };
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
  const headers = [];
  for (let h = from; h <= to; h++) {
    const bytes = fromHex(await call('getblockheader', [await call('getblockhash', [h]), false]));
    if (bytes.length !== HEADER_BYTES) throw new Error(`block ${h} came back as ${bytes.length} bytes, not a header`);
    headers.push(bytes);
  }
  return { headers, firstHeight: from, tipHeight: to };
}

export async function headersToTip(call, { count } = {}) {
  if (!Number.isInteger(count) || count < 1)
    return Promise.reject(new Error('a header window is at least one block'));
  if (count > MAX_HEADERS)
    return Promise.reject(new Error(`a window of ${count} is more than the ${MAX_HEADERS} this asks for at once`));

  const tip = Number(await call('getblockcount'));
  if (!Number.isInteger(tip) || tip < 0) throw new Error('bitcoind gave no block count');
  const firstHeight = Math.max(0, tip - count + 1);

  const headers = [];
  for (let h = firstHeight; h <= tip; h++) {
    const hash = await call('getblockhash', [h]);
    const hex = await call('getblockheader', [hash, false]);
    const bytes = fromHex(hex);
    if (bytes.length !== HEADER_BYTES)
      throw new Error(`block ${h} came back as ${bytes.length} bytes, not a header`);
    headers.push(bytes);
  }
  return { headers, firstHeight, tipHeight: tip };
}
