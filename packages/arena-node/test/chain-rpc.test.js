// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE'S OWN CHAIN, OVER RPC - and what it does when there is not one.
//
// The committee seed is a block hash the chain names (5A.5, and letter 32's
// selection rule). `beaconFromChain` decides WHICH block; this file is what
// fetches the headers it decides on. It decides nothing itself, and the tests
// below are mostly about that: the window it asks for, the shape it refuses,
// and that a missing daemon produces no beacon rather than a stale one.
//
// The daemon itself is driven by `tools/beacon-regtest.mjs` against an
// isolated regtest, and its numbers are in TASKBOOK. What is here runs with no
// daemon at all, because a suite that needs one is a suite nobody runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bitcoindRpc, headersToTip, MAX_HEADERS } from '../src/chain-rpc.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { hash256, blockHashOf, HEADER_BYTES } from '../../arena-protocol/src/chain.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const BASE = 1_700_000_000;

/** A little chain and a bitcoind that serves it, with no bitcoind. */
function fakeNode(n, { firstHeight = 0, breakAt = null } = {}) {
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time: BASE + i * 600 });
    headers.push(header);
    previous = blockHashOf(header);
  }
  const asked = [];
  const call = async (method, params = []) => {
    asked.push([method, ...params]);
    if (method === 'getblockcount') return firstHeight + n - 1;
    if (method === 'getblockhash') return toHex(blockHashOf(headers[params[0] - firstHeight]));
    if (method === 'getblockheader') {
      const at = headers.findIndex((h) => toHex(blockHashOf(h)) === params[0]);
      if (at === breakAt) return 'aabbcc';            // a short answer, not a header
      return toHex(headers[at]);
    }
    throw new Error('the node was asked something this test does not serve: ' + method);
  };
  return { headers, firstHeight, call, asked };
}

test('the window ends at the tip and is asked for height by height', async () => {
  const node = fakeNode(20, { firstHeight: 100 });
  const seen = await headersToTip(node.call, { count: 5 });

  assert.equal(seen.tipHeight, 119);
  assert.equal(seen.firstHeight, 115, 'a window of five ending at 119 starts at 115');
  assert.equal(seen.headers.length, 5);
  for (const h of seen.headers) assert.equal(h.length, HEADER_BYTES);
  assert.deepEqual(seen.headers[0], node.headers[15]);

  // the height is read ONCE and then walked, so a chain that grows during the
  // read cannot hand back a list with a hole in it
  assert.equal(node.asked.filter((a) => a[0] === 'getblockcount').length, 1);
  assert.deepEqual(node.asked.filter((a) => a[0] === 'getblockhash').map((a) => a[1]),
    [115, 116, 117, 118, 119]);
});

test('a chain shorter than the window is served whole rather than padded', async () => {
  const node = fakeNode(4, { firstHeight: 0 });
  const seen = await headersToTip(node.call, { count: 10 });
  assert.equal(seen.firstHeight, 0);
  assert.equal(seen.headers.length, 4, 'the reader invented blocks to fill a window');
});

test('a window of nothing, or of more than this asks for at once, is refused', async () => {
  const node = fakeNode(4);
  await assert.rejects(headersToTip(node.call, { count: 0 }), /at least one block/);
  await assert.rejects(headersToTip(node.call, {}), /at least one block/);
  await assert.rejects(headersToTip(node.call, { count: MAX_HEADERS + 1 }),
    new RegExp(`more than the ${MAX_HEADERS}`));
});

test('an answer that is not a header is refused, not padded into one', async () => {
  const node = fakeNode(6, { firstHeight: 0, breakAt: 4 });
  await assert.rejects(headersToTip(node.call, { count: 6 }),
    /block 4 came back as 3 bytes, not a header/);
});

test('no daemon means no beacon, and the refusal says which', async () => {
  const noCookie = bitcoindRpc({ url: 'http://127.0.0.1:1/', cookiePath: '/nowhere/.cookie' });
  await assert.rejects(headersToTip(noCookie, { count: 4 }),
    /no bitcoind cookie at \/nowhere\/.cookie/);
  await assert.rejects(headersToTip(noCookie, { count: 4 }),
    /a beacon is not invented when one is missing/);

  const dead = bitcoindRpc({
    url: 'http://127.0.0.1:1/',
    readCookie: () => 'user:pass',
    fetcher: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });
  await assert.rejects(headersToTip(dead, { count: 4 }),
    /bitcoind at http:\/\/127.0.0.1:1\/ did not answer getblockcount: connect ECONNREFUSED/);
});

test('bitcoind saying no is not bitcoind saying nothing', async () => {
  const refuses = bitcoindRpc({
    url: 'http://x/', readCookie: () => 'u:p',
    fetcher: () => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'Block height out of range' } })),
    }),
  });
  await assert.rejects(headersToTip(refuses, { count: 4 }),
    /bitcoind refused getblockcount: Block height out of range/);

  const unauthorised = bitcoindRpc({
    url: 'http://x/', readCookie: () => 'u:p',
    fetcher: () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('unauthorized') }),
  });
  await assert.rejects(headersToTip(unauthorised, { count: 4 }), /bitcoind answered 401/);

  const html = bitcoindRpc({
    url: 'http://x/', readCookie: () => 'u:p',
    fetcher: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('<html>') }),
  });
  await assert.rejects(headersToTip(html, { count: 4 }), /not json/);
});

test('what it reads is what the rule judges, with no second chooser between', async () => {
  const node = fakeNode(20, { firstHeight: 100 });
  const window = await headersToTip(node.call, { count: 20 });
  const contract = {
    networkId: NETWORK_ID_REGTEST,
    committeeTimeMs: BigInt(BASE + 6 * 600) * 1000n,
    censusConfirmations: 3,
    censusRoot: b32(2),
    randomnessRule: 'bitcoin-block-hash',
  };

  const seen = beaconFromChain(contract, window);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.height, 112, 'the reader moved the block the rule would have picked');
  assert.deepEqual(seen.hash, blockHashOf(node.headers[12]));
});

// ONE COPY OF A BLOCK, HOWEVER MANY VIEWS HOLD IT (2026-10-02: the free pair's nodes held 3.8 GB each - a ~2,000-block
// view per round, 2,511 rounds over 19 census heights). Two overlapping views through one cache: the second asks bitcoind
// only for the blocks the first did not read, and holds the very same block objects; a reorganised height (a new hash)
// is read again, never answered from the old block.
test('a shared block cache: an overlapping view reads only its new blocks and holds the same objects; a new hash at a height is read again', async () => {
  const { blocksOver, blockCache } = await import('../src/chain-rpc.js');
  const hashAt = new Map([[0, 'h0'], [1, 'h1'], [2, 'h2'], [3, 'h3'], [4, 'h4']]);
  // a header, one transaction: version, 1 input (36-byte outpoint, 1-byte script, sequence), 1 output (value, empty
  // script), locktime - 61 bytes
  const tx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
  const rawFor = (hash) => { const b = new Uint8Array([...new Array(80).fill(0), 1, ...tx]); b[0] = hash.length; b[1] = hash.charCodeAt(1); return b; };
  let reads = 0;
  const call = async (method, [arg]) => {
    if (method === 'getblockhash') return hashAt.get(arg);
    if (method === 'getbestblockhash') return hashAt.get(Math.max(...hashAt.keys()));
    if (method === 'getblock') { reads++; return Buffer.from(rawFor(arg)).toString('hex'); }
    throw new Error(method);
  };
  const cache = blockCache();
  const first = await blocksOver(call, 0, 3, { cache });
  const afterFirst = reads;
  const second = await blocksOver(call, 1, 4, { cache });
  const afterSecond = reads;
  hashAt.set(4, 'h4b');
  const third = await blocksOver(call, 3, 4, { cache });
  console.log('  FACTS:', JSON.stringify({ afterFirst, afterSecond, afterReorg: reads, cached: cache.size }));
  assert.equal(afterFirst, 4);
  assert.equal(afterSecond, 5, 'the overlapping view read blocks the cache held');
  assert.equal(second.blocks[0], first.blocks[1], 'two views hold two copies of one block');
  assert.equal(reads, 6, 'the reorganised height was not read again');
  assert.notEqual(third.blocks[1], second.blocks[3], 'a new hash was answered with the old block');
  const small = blockCache({ max: 2 });
  small.put('a', 1); small.put('b', 2); small.put('c', 3);
  assert.deepEqual([small.get('a'), small.get('b'), small.get('c'), small.size], [undefined, 2, 3, 2]);
});

test('views read at the same time share one read of each block and hold one object of it (the load, 2026-10-15)', async () => {
  const { blocksOver, blockCache } = await import('../src/chain-rpc.js');
  const tx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
  const rawFor = (hash) => { const b = new Uint8Array([...new Array(80).fill(0), 1, ...tx]); b[0] = hash.length; b[1] = hash.charCodeAt(1); return b; };
  let reads = 0;
  // bitcoind answers a block only after a while: every view asks for it before the first answer is back
  const call = async (method, [arg]) => {
    if (method === 'getblockhash') return `h${arg}`;
    if (method === 'getbestblockhash') return 'h9';   // the chain these views read ends at 9
    if (method === 'getblock') { reads++; await new Promise((r) => setTimeout(r, 20)); return Buffer.from(rawFor(arg)).toString('hex'); }
    throw new Error(method);
  };
  const cache = blockCache();
  const views = await Promise.all(Array.from({ length: 8 }, () => blocksOver(call, 0, 9, { cache })));
  console.log('  CONCURRENT:', JSON.stringify({ views: views.length, blocks: 10, reads, cached: cache.size, inFlight: cache.inFlight.size }));
  assert.equal(reads, 10, 'a block was read more than once while its first read was out');
  for (const v of views) for (let i = 0; i < 10; i++) assert.equal(v.blocks[i], views[0].blocks[i], 'two views hold two copies of one block');
  assert.equal(cache.inFlight.size, 0, 'a finished read stayed in flight');
  // a read that fails is not kept: the next asker reads again
  let fail = true;
  const flaky = async (method, [arg]) => { if (method === 'getblockhash') return `x${arg}`; if (method === 'getbestblockhash') return 'x0'; if (fail) { fail = false; throw new Error('bitcoind said no'); } return Buffer.from(rawFor(`x${arg}`)).toString('hex'); };
  await assert.rejects(blocksOver(flaky, 0, 0, { cache }), /bitcoind said no/);
  assert.equal(cache.inFlight.size, 0);
  assert.equal((await blocksOver(flaky, 0, 0, { cache })).blocks.length, 1);
});

// KANBAN ITEM 4 (measured on seat 3's start 2026-10-18: the chain RPC was 9 % of the main thread's first minute, the cookie file
// read on every call 2.7 %): a census view asks bitcoind only for the hashes near its top once the deep ones are kept, and the
// cookie is read once - again only after bitcoind refuses it.
test('a second census view asks only its top DEEP_BLOCKS heights; the cookie is read once and again after a 401', async () => {
  const { blocksOver, blockCache, DEEP_BLOCKS } = await import('../src/chain-rpc.js');
  const asked = [];
  // testnet4's block 0, raw: one block every height answers (the view only divides the bytes; the census checks the links)
  const hexOf = '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c78170101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5504ffff001d01044c4c30332f4d61792f323032342030303030303030303030303030303030303030303165626435386332343439373062336161396437383362623030313031316662653865613865393865303065ffffffff0100f2052a010000002321000000000000000000000000000000000000000000000000000000000000000000ac00000000';
  let tip = 99;   // the best block follows the tip, as bitcoind's does
  const call = async (method, params) => { asked.push(method); return method === 'getblockhash' ? `${String(params[0]).padStart(64, '0')}` : method === 'getbestblockhash' ? `best-${tip}` : hexOf; };
  const cache = blockCache();
  await blocksOver(call, 0, 99, { cache });
  assert.equal(asked.filter((m) => m === 'getblockhash').length, 100, 'the first view reads every height');
  asked.length = 0;
  tip = 101;
  const v = await blocksOver(call, 0, 101, { cache });
  assert.equal(v.blocks.length, 102);
  assert.equal(asked.filter((m) => m === 'getblockhash').length, DEEP_BLOCKS + 2, 'the second: its top DEEP_BLOCKS and the two new heights');
  assert.equal(asked.filter((m) => m === 'getblock').length, 2, 'blocks it holds are not read again');

  let reads = 0, cookieNow = 'u:one';
  const seen = [];
  const fetcher = async (_url, init) => {
    seen.push(init.headers.authorization);
    const ok = init.headers.authorization === `Basic ${Buffer.from(cookieNow).toString('base64')}`;
    return new Response(ok ? JSON.stringify({ result: 7, error: null }) : 'no', { status: ok ? 200 : 401 });
  };
  const rpc = bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => { reads += 1; return cookieNow; } });
  for (let i = 0; i < 5; i++) assert.equal(await rpc('getblockcount'), 7);
  assert.equal(reads, 1, 'read once for five calls');
  cookieNow = 'u:two';                 // bitcoind restarted: a new cookie
  assert.equal(await rpc('getblockcount'), 7, 'the 401 reads the new cookie and asks again');
  assert.equal(reads, 2);
});

// A KEPT HASH FROM A BRANCH THE CHAIN LEFT (kanban #495, measured 2026-10-21 on the three installer nodes: every founding census since
// 157,115 failed "that is not a chain: this header does not follow the one before it")
test('a census that is not a chain is read once more with the kept hashes dropped; one that is a chain is read once', async () => {
  const { censusWithFreshHashes, blockCache } = await import('../src/chain-rpc.js');
  const cache = blockCache();
  cache.putHash(100, 'stale');
  let reads = 0;
  const derive = () => (cache.hashes.has(100) ? { ok: false, why: 'that is not a chain: this header does not follow the one before it' } : { ok: true, entries: [] });
  const got = await censusWithFreshHashes({ read: async () => { reads++; return {}; }, derive, cache });
  assert.deepEqual([got.ok, reads, cache.hashes.size], [true, 2, 0]);
  // a good view: one read, the kept hashes kept
  cache.putHash(101, 'fine'); reads = 0;
  const ok = await censusWithFreshHashes({ read: async () => { reads++; return {}; }, derive: () => ({ ok: true, entries: [] }), cache });
  assert.deepEqual([ok.ok, reads, cache.hashes.size], [true, 1, 1]);
  // another failure is not retried
  reads = 0;
  const other = await censusWithFreshHashes({ read: async () => { reads++; return {}; }, derive: () => ({ ok: false, why: 'no bond' }), cache });
  assert.deepEqual([other.ok, reads], [false, 1]);
  // and the seat's chain census uses it
  const main = (await import('node:fs')).readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /censusWithFreshHashes\(\{ read, derive: \(view\) => censusOfView\(view, contract\), cache: blocksKept \}\)/);
});

// A ROUND'S VIEW FROM A KEPT HASH OF A BRANCH THE CHAIN LEFT (kanban #576, measured 2026-10-21 ~22:00Z on node-15: every round's view
// failed "that is not a chain", so no round was assigned and its series writer held a core at 100 % asking again)
test('a round view that does not link is read once more with the kept hashes dropped; one that links is read once', async () => {
  const { viewWithFreshHashes, viewLinks, blockCache } = await import('../src/chain-rpc.js');
  const headerAfter = (prev, n) => { const h = new Uint8Array(HEADER_BYTES); h.set(prev, 4); h[0] = n; return h; };
  const chain = (n, first = headerAfter(new Uint8Array(32), 1)) => {
    const blocks = [{ header: first, transactions: [] }];
    for (let i = 1; i < n; i++) blocks.push({ header: headerAfter(blockHashOf(blocks[i - 1].header), i + 1), transactions: [] });
    return { blocks, firstHeight: 0 };
  };
  const good = chain(5);
  const broken = { ...good, blocks: [...good.blocks] };
  broken.blocks[2] = { header: headerAfter(new Uint8Array(32).fill(7), 99), transactions: [] };   // a block of another branch
  assert.deepEqual([viewLinks(good), viewLinks(broken)], [true, false]);
  const cache = blockCache();
  cache.putHash(2, 'stale');
  let reads = 0;
  const got = await viewWithFreshHashes({ read: async () => { reads++; return cache.hashes.has(2) ? broken : good; }, cache });
  assert.deepEqual([got === good, reads, cache.hashes.size], [true, 2, 0]);
  cache.putHash(3, 'fine'); reads = 0;
  const once = await viewWithFreshHashes({ read: async () => { reads++; return good; }, cache });
  assert.deepEqual([once === good, reads, cache.hashes.size], [true, 1, 1]);
  // and the seat reads its rounds' views through it
  const main = (await import('node:fs')).readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /viewWithFreshHashes\(\{ read: \(\) => blocksOver\(call, Math\.max\(0, contract\.censusHeight - CENSUS_LOOKBACK\), to, \{ cache: blocksKept \}\), cache: blocksKept \}\)/);
});

// THE SERIES WRITER BACKS OFF A REFUSED ASSIGNMENT (kanban #576): a refusal that cost a census waits a minute; a view not read yet,
// which costs none, is asked next pass as before
test('the series writer skips a round refused within the last minute, and remembers no refusal for a view not read yet', async () => {
  const server = (await import('node:fs')).readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /if \(Date\.now\(\) - \(refusedAt\.get\(hex\) \|\| 0\) < REFUSED_RETRY_MS\) continue;/);
  assert.match(server, /const REFUSED_RETRY_MS = 60000;/);
  assert.match(server, /else if \(assigned\.why !== NO_CHAIN_VIEW_WHY && !\/still reading its chain view\/\.test\(String\(assigned\.why\)\)\) refusedAt\.set\(hex, Date\.now\(\)\);/);
});

test('the top of a view is asked once while the best block stays, and again once it moves (kanban #587)', async () => {
  const { blocksOver, blockCache, DEEP_BLOCKS } = await import('../src/chain-rpc.js');
  const top = DEEP_BLOCKS + 10;
  const hashAt = new Map(Array.from({ length: top + 1 }, (_, h) => [h, `h${h}`]));
  const tx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
  const rawFor = (hash) => new Uint8Array([...new Array(80).fill(hash.length), 1, ...tx]);
  const asked = [];
  const call = async (method, [arg] = []) => {
    asked.push(method);
    if (method === 'getblockhash') return hashAt.get(arg);
    if (method === 'getbestblockhash') return hashAt.get(Math.max(...hashAt.keys()));
    if (method === 'getblock') return Buffer.from(rawFor(arg)).toString('hex');
    throw new Error(method);
  };
  const cache = blockCache();
  await blocksOver(call, 0, top, { cache });
  const firstHashes = asked.filter((m) => m === 'getblockhash').length;
  assert.equal(firstHashes, top + 1, 'the first view asks every height once');
  asked.length = 0;
  const again = await blocksOver(call, 0, top, { cache });
  assert.deepEqual([asked.filter((m) => m === 'getblockhash').length, asked.filter((m) => m === 'getbestblockhash').length], [0, 1],
    'the same view under the same best block asks no height again - only the best hash, once');
  // a new block at the top: the best hash moves, the top heights are asked again, and the new block is read
  hashAt.set(top + 1, `h${top + 1}`);
  asked.length = 0;
  const grown = await blocksOver(call, 1, top + 1, { cache });
  assert.ok(asked.filter((m) => m === 'getblockhash').length >= DEEP_BLOCKS, 'the best block moved: the top heights are asked again');
  assert.equal(grown.blocks.length, top + 1);
  // a reorganised top: same height, another hash, another best - the old one is never answered
  hashAt.set(top + 1, 'h-other');
  const reorg = await blocksOver(call, top, top + 1, { cache });
  assert.notEqual(reorg.blocks[1], grown.blocks[top], 'a block of the branch the chain left was answered');
  assert.equal(again.blocks.length, top + 1);
});

test('views walking the same heights at once ask each height once, not once per view (kanban #587)', async () => {
  const { blocksOver, blockCache } = await import('../src/chain-rpc.js');
  const tx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
  const rawFor = (hash) => new Uint8Array([...new Array(80).fill(hash.length), 1, ...tx]);
  const asked = new Map();
  // bitcoind answers a little later, so the eight views are all walking before the first answer is back
  const call = async (method, [arg] = []) => {
    asked.set(method, (asked.get(method) || 0) + 1);
    await new Promise((r) => setTimeout(r, 2));
    if (method === 'getblockhash') return `h${arg}`;
    if (method === 'getbestblockhash') return 'h99';
    if (method === 'getblock') return Buffer.from(rawFor(arg)).toString('hex');
    throw new Error(method);
  };
  const cache = blockCache();
  const views = await Promise.all(Array.from({ length: 8 }, () => blocksOver(call, 0, 99, { cache })));
  assert.equal(asked.get('getblockhash'), 100, `100 heights, ${asked.get('getblockhash')} asks`);
  assert.equal(asked.get('getblock'), 100);
  for (const v of views) assert.equal(v.blocks.length, 100);
  assert.equal(cache.hashInFlight.size, 0, 'a finished ask stayed in flight');
});
