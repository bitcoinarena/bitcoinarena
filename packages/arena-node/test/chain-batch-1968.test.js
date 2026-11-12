// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RESTARTED SEAT'S CHAIN VIEWS IN A FEW REQUESTS, NOT TENS OF THOUSANDS (kanban #1968, measured 2026-11-12 on the testnet4 seats: a
// restarted seat answered "this node has no chain view for that round" for every paid round for 30-45 min. Its 105 view keys and their
// beacons were ~35,500 calls, one HTTP request each through two bitcoind lanes; a busy seat held a lane ~100 ms a request, ~20 a second,
// while bitcoind sat idle). The calls now go JSON-RPC batched: the same hashes, blocks and headers, in a few hundred requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitcoindRpc, blocksOver, blockCache, headersFrom, headersToTip, DEEP_BLOCKS, HASH_BATCH } from '../src/chain-rpc.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// a header and one 61-byte transaction, its first byte saying which block it is (the view only divides the bytes)
const tx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
const rawFor = (h) => { const b = new Uint8Array([...new Array(80).fill(0), 1, ...tx]); b[0] = h & 255; b[1] = (h >> 8) & 255; return Buffer.from(b).toString('hex'); };

/** A bitcoind over HTTP that serves `n` blocks, through a real bitcoindRpc: every request it answers is counted. */
function fakeBitcoind(n, { delayMs = 0 } = {}) {
  const posts = [];
  const answer = ({ method, params = [] }) => {
    if (method === 'getblockcount') return n - 1;
    if (method === 'getbestblockhash') return `h${n - 1}`;
    if (method === 'getblockhash') { if (params[0] >= n) throw new Error('Block height out of range'); return `h${params[0]}`; }
    if (method === 'getblock') return rawFor(Number(String(params[0]).slice(1)));
    throw new Error(`not served: ${method}`);
  };
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    posts.push(Array.isArray(body) ? body.map((x) => x.method) : [body.method]);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const one = (q) => { try { return { id: q.id, result: answer(q), error: null }; } catch (e) { return { id: q.id, result: null, error: { code: -8, message: e.message } }; } };
    // a batch answered in another order than asked: the ids say which is which
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one).reverse() : one(body)), { status: 200 });
  };
  return { call: bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => 'u:p' }), posts };
}

test('a batch is one request, its results in the order asked; a refused call refuses the batch', async () => {
  const node = fakeBitcoind(10);
  assert.equal(typeof node.call.batch, 'function', 'bitcoindRpc has no batch');
  assert.deepEqual(await node.call.batch([['getblockhash', [3]], ['getblockcount'], ['getblockhash', [0]]]), ['h3', 9, 'h0']);
  assert.equal(node.posts.length, 1);
  await assert.rejects(node.call.batch([['getblockhash', [1]], ['getblockhash', [99]]]), /bitcoind refused getblockhash: Block height out of range/);
  assert.equal(await node.call('getblockhash', [4]), 'h4', 'a single call answers as before');
});

test('a 2,000-block view is a few requests, the same blocks as one call a height; views read together share them (kanban #1968)', async () => {
  const n = 2000;
  const serial = fakeBitcoind(n);
  const one = (m, p) => serial.call(m, p);           // no batch: the walk as it was
  const before = await blocksOver(one, 0, n - 1, { cache: blockCache() });
  const node = fakeBitcoind(n, { delayMs: 1 });
  const cache = blockCache();
  const views = await Promise.all(Array.from({ length: 8 }, () => blocksOver(node.call, 0, n - 1, { cache })));
  const asked = node.posts.flat();
  const by = {}; for (const m of asked) by[m] = (by[m] || 0) + 1; const sizes = {}; for (const p of node.posts) sizes[p.length] = (sizes[p.length] || 0) + 1; console.log('  BY:', JSON.stringify(by), JSON.stringify(sizes));
  console.log('  FACTS:', JSON.stringify({ serialRequests: serial.posts.length, batchedRequests: node.posts.length, calls: asked.length, cached: cache.size }));
  assert.ok(serial.posts.length >= 2 * n, 'the serial walk was one request a call');
  assert.ok(node.posts.length <= 150, `${node.posts.length} requests for a 2,000-block view`);
  assert.equal(asked.filter((m) => m === 'getblock').length, n, 'a block was read more than once');
  assert.ok(asked.filter((m) => m === 'getblockhash').length <= n + 8 * DEEP_BLOCKS, 'a deep height was asked more than once');
  for (const v of views) {
    assert.equal(v.firstHeight, 0); assert.equal(v.blocks.length, n);
    for (let i = 0; i < n; i++) {
      assert.equal(v.blocks[i], views[0].blocks[i], 'two views hold two copies of one block');
      assert.deepEqual(v.blocks[i].header, before.blocks[i].header);
      assert.deepEqual(v.blocks[i].transactions, before.blocks[i].transactions);
    }
  }
  assert.equal(cache.inFlight.size + cache.hashInFlight.size, 0, 'a finished read stayed in flight');
  // a second view over the same window asks only its top again
  node.posts.length = 0;
  await blocksOver(node.call, 0, n - 1, { cache });
  assert.ok(node.posts.flat().length <= DEEP_BLOCKS + 1, `${node.posts.flat().length} calls for a view the cache holds`);
  // and a height past the tip refuses the view, as it did
  await assert.rejects(blocksOver(node.call, 0, n + 100, { cache: blockCache() }), /Block height out of range/);
});

test('a beacon\'s headers read back from a census height are the same headers in a few requests (kanban #1968)', async () => {
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < 1500; i++) { const { header } = blockOf(hash256, [new Uint8Array(32).fill(i & 255)], { previous, time: 1_700_000_000 + i * 600 }); headers.push(header); previous = blockHashOf(header); }
  const posts = [];
  const answer = ({ method, params = [] }) => method === 'getblockcount' ? headers.length - 1
    : method === 'getblockhash' ? toHex(blockHashOf(headers[params[0]]))
      : toHex(headers[headers.findIndex((h) => toHex(blockHashOf(h)) === params[0])]);
  const fetcher = async (_u, init) => { const b = JSON.parse(init.body); posts.push(b); return new Response(JSON.stringify(Array.isArray(b) ? b.map((q) => ({ id: q.id, result: answer(q), error: null })) : { id: b.id, result: answer(b), error: null })); };
  const call = bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => 'u:p' });
  const got = await headersFrom(call, { from: 100, count: 1200 });
  assert.equal(got.firstHeight, 100); assert.equal(got.tipHeight, 1299);
  assert.deepEqual(got.headers, headers.slice(100, 1300));
  assert.ok(posts.length <= 1 + 2 * Math.ceil(1200 / HASH_BATCH), `${posts.length} requests for 1,200 headers`);
  posts.length = 0;
  const win = await headersToTip(call, { count: 400 });
  assert.equal(win.firstHeight, 1100); assert.deepEqual(win.headers, headers.slice(1100));
  assert.ok(posts.length <= 3, `${posts.length} requests for a 400-header window`);
});
