// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute item 100 (#1968, after #2217 / 873705a38), skeptic 2: a STRANGER (any testnet4 miner - min-difficulty
// blocks after 20 min) shapes the chain the seat reads: a run of tiny blocks teaches the shared count 32, then 32 large blocks
// come in ONE request; and the retry path never shrinks a request that failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitcoindRpc, blocksOver, blockCache, BLOCK_BATCH_BYTES } from '../src/chain-rpc.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const smallTx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
const bigTx = (n) => {
  const b = Buffer.alloc(4 + 1 + 36 + 5 + n + 4 + 1 + 8 + 1 + 4);
  let o = 0; b.writeUInt32LE(1, o); o += 4; b[o++] = 1; o += 36; b[o++] = 0xfe; b.writeUInt32LE(n, o); o += 4; o += n;
  b.writeUInt32LE(0xffffffff, o); o += 4; b[o++] = 1; o += 8; b[o++] = 0; b.writeUInt32LE(0, o);
  return b;
};
function chainOf(n) {
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill(i & 255)], { previous, time: 1_700_000_000 + i * 600 });
    headers.push(header); previous = blockHashOf(header);
  }
  return headers;
}
const BIG = 1_000_000;
// heights >= tinyUpTo are 1 MB blocks (testnet4 / mainnet blocks reach ~4 MB raw: 4x everything below)
function nodeOver(chain, tinyUpTo, { failOver = Infinity } = {}) {
  const sizes = [];
  const big = bigTx(BIG);
  const answer = ({ method, params = [] }) => {
    if (method === 'getblockcount') return chain.length - 1;
    if (method === 'getbestblockhash') return toHex(blockHashOf(chain[chain.length - 1]));
    if (method === 'getblockhash') return toHex(blockHashOf(chain[params[0]]));
    const at = chain.findIndex((h) => toHex(blockHashOf(h)) === params[0]);
    if (method === 'getblock') return Buffer.concat([Buffer.from(chain[at]), Buffer.from([1]), at >= tinyUpTo ? big : Buffer.from(smallTx)]).toString('hex');
    throw new Error(`not served: ${method}`);
  };
  const fetcher = async (_u, init) => {
    const b = JSON.parse(init.body);
    const one = (q) => ({ id: q.id, result: answer(q), error: null });
    const text = JSON.stringify(Array.isArray(b) ? b.map(one) : one(b));
    sizes.push({ methods: Array.isArray(b) ? b.length : 1, first: Array.isArray(b) ? b[0].method : b.method, bytes: text.length });
    // a request whose answer is too large to come back inside the seat's fetch timeout (ARENA_FETCH_TIMEOUT_MS, 30 s, queue included)
    if (text.length > failOver) throw new Error('The operation was aborted due to timeout');
    return new Response(text, { status: 200 });
  };
  return { call: bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => 'u:p' }), sizes };
}

test('#1968 refute s2-1: 62 tiny blocks teach the shared count 32, then 32 large blocks are ONE request far over BLOCK_BATCH_BYTES', async () => {
  const chain = chainOf(126);
  const node = nodeOver(chain, 62);
  const v = await blocksOver(node.call, 0, 125, { cache: blockCache() });
  assert.equal(v.blocks.length, 126);
  const reqs = node.sizes.filter((s) => s.first === 'getblock' && s.methods > 1);
  console.log('  getblock batches [calls, bytes]', JSON.stringify(reqs.map((s) => [s.methods, s.bytes])));
  const max = Math.max(...reqs.map((s) => s.bytes));
  assert.ok(max <= BLOCK_BATCH_BYTES + 2 * (2 * BIG + 200) + 4096, `one request answered ${max} bytes of hex, ${(max / BLOCK_BATCH_BYTES).toFixed(1)}x the ${BLOCK_BATCH_BYTES} budget`);
});

test('#1968 refute s2-2: a getblock batch that failed is asked again at the same size on every retry - the view never completes', async () => {
  const chain = chainOf(126);
  const node = nodeOver(chain, 62, { failOver: 3 * BLOCK_BATCH_BYTES });
  const cache = blockCache();
  let done = null, last = null;
  for (let attempt = 1; attempt <= 5 && !done; attempt++) {
    try { done = await blocksOver(node.call, 0, 125, { cache }); } catch (e) { last = e.message; }
  }
  const failed = node.sizes.filter((s) => s.first === 'getblock' && s.bytes > 3 * BLOCK_BATCH_BYTES);
  console.log('  failed getblock batches [calls, bytes]', JSON.stringify(failed.map((s) => [s.methods, s.bytes])), 'last error:', last);
  assert.ok(done, `5 attempts, ${failed.length} identical oversized requests, no view (one block a request, as before #1968, would have read it)`);
  assert.equal(done.blocks.length, 126);
});

// kanban #2441 / #2492: the fix. A bitcoind that answers getblockstats (every bitcoind since 0.17) has each part packed by the
// blocks' own sizes; one that fails a request has the next one halved.
function sizedNodeOver(chain, tinyUpTo, { failOverBlocks = Infinity } = {}) {
  const sizes = [];
  const big = bigTx(BIG);
  const raw = (at) => Buffer.concat([Buffer.from(chain[at]), Buffer.from([1]), at >= tinyUpTo ? big : Buffer.from(smallTx)]);
  const answer = ({ method, params = [] }) => {
    if (method === 'getblockcount') return chain.length - 1;
    if (method === 'getbestblockhash') return toHex(blockHashOf(chain[chain.length - 1]));
    if (method === 'getblockhash') return toHex(blockHashOf(chain[params[0]]));
    const at = chain.findIndex((h) => toHex(blockHashOf(h)) === params[0]);
    if (method === 'getblockstats') { assert.deepEqual(params[1], ['total_size']); return { total_size: raw(at).length }; }
    if (method === 'getblock') return raw(at).toString('hex');
    throw new Error(`not served: ${method}`);
  };
  const fetcher = async (_u, init) => {
    const b = JSON.parse(init.body);
    const n = Array.isArray(b) ? b.length : 1, first = Array.isArray(b) ? b[0].method : b.method;
    // a getblock request of more than `failOverBlocks` blocks times out (queued behind the other lane), whatever its bytes
    if (first === 'getblock' && n > failOverBlocks) { sizes.push({ methods: n, first, bytes: -1 }); throw new Error('The operation was aborted due to timeout'); }
    const one = (q) => ({ id: q.id, result: answer(q), error: null });
    const text = JSON.stringify(Array.isArray(b) ? b.map(one) : one(b));
    sizes.push({ methods: n, first, bytes: text.length });
    return new Response(text, { status: 200 });
  };
  return { call: bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => 'u:p' }), sizes };
}

test('#2441: with the sizes from getblockstats, tiny blocks go 32 a request and the large ones after them stay inside BLOCK_BATCH_BYTES', async () => {
  const chain = chainOf(126);
  const node = sizedNodeOver(chain, 62);
  const v = await blocksOver(node.call, 0, 125, { cache: blockCache() });
  assert.equal(v.blocks.length, 126);
  const reqs = node.sizes.filter((s) => s.first === 'getblock' && s.methods > 1);
  console.log('  getblock batches [calls, bytes]', JSON.stringify(reqs.map((s) => [s.methods, s.bytes])));
  assert.equal(reqs[0].methods, 32, 'tiny blocks are still read 32 to a request');
  for (const r of reqs) assert.ok(r.bytes <= BLOCK_BATCH_BYTES + 4096, `one request answered ${r.bytes} bytes of hex`);
  assert.ok(reqs.some((r) => r.methods === Math.floor(BLOCK_BATCH_BYTES / (2 * BIG + 200))), 'the large blocks are not packed up to the budget');
});

test('#2492: a getblock request that failed is never asked again at its size - each retry asks half, and the view completes', async () => {
  const chain = chainOf(126);
  const node = sizedNodeOver(chain, 1000, { failOverBlocks: 5 });   // all tiny: 32 to a request by size, but more than 5 time out
  const cache = blockCache();
  let done = null; const errors = [];
  for (let attempt = 1; attempt <= 6 && !done; attempt++) {
    try { done = await blocksOver(node.call, 0, 125, { cache }); } catch (e) { errors.push(e.message); }
  }
  const tried = node.sizes.filter((s) => s.first === 'getblock' && s.methods > 1).map((s) => [s.methods, s.bytes < 0 ? 'failed' : 'ok']);
  console.log('  getblock batches', JSON.stringify(tried));
  assert.ok(done, `no view after ${errors.length} failures`);
  assert.equal(done.blocks.length, 126);
  const failed = tried.filter((t) => t[1] === 'failed').map((t) => t[0]);
  assert.deepEqual(failed, [32, 16, 8], 'each failed request was half of the one before');
  assert.equal(cache.inFlight.size, 0);
});
