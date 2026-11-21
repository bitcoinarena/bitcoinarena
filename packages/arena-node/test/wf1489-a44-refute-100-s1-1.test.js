// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute item 100 (#1968): variants against the batched chain reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitcoindRpc, blocksOver, blockCache, BLOCK_BATCH_BYTES } from '../src/chain-rpc.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const smallTx = [1, 0, 0, 0, 1, ...new Array(36).fill(0), 1, 0, 255, 255, 255, 255, 1, ...new Array(8).fill(0), 0, 0, 0, 0, 0];
// a tx with a scriptSig of `n` bytes (varint 0xfe)
const bigTx = (n) => {
  const b = Buffer.alloc(4 + 1 + 36 + 5 + n + 4 + 1 + 8 + 1 + 4);
  let o = 0; b.writeUInt32LE(1, o); o += 4; b[o++] = 1; o += 36; b[o++] = 0xfe; b.writeUInt32LE(n, o); o += 4; o += n;
  b.writeUInt32LE(0xffffffff, o); o += 4; b[o++] = 1; o += 8; b[o++] = 0; b.writeUInt32LE(0, o);
  return b;
};

function chainOf(n, { salt = 0, from = null } = {}) {
  const headers = from ? from.slice() : [];
  let previous = headers.length ? blockHashOf(headers[headers.length - 1]) : new Uint8Array(32);
  for (let i = headers.length; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill((i + salt) & 255)], { previous, time: 1_700_000_000 + i * 600 + salt });
    headers.push(header); previous = blockHashOf(header);
  }
  return headers;
}

function nodeOver(getChain, { bigBytes = 0, failOnce = null } = {}) {
  const posts = []; const sizes = [];
  let failed = false;
  const answer = ({ method, params = [] }) => {
    const headers = getChain();
    if (method === 'getblockcount') return headers.length - 1;
    if (method === 'getbestblockhash') return toHex(blockHashOf(headers[headers.length - 1]));
    if (method === 'getblockhash') { if (params[0] >= headers.length) throw new Error('Block height out of range'); return toHex(blockHashOf(headers[params[0]])); }
    const at = headers.findIndex((h) => toHex(blockHashOf(h)) === params[0]);
    if (at < 0) throw new Error('Block not found');
    if (method === 'getblockheader') return toHex(headers[at]);
    if (method === 'getblock') {
      const tx = bigBytes ? bigTx(bigBytes) : Buffer.from(smallTx);
      return Buffer.concat([Buffer.from(headers[at]), Buffer.from([1]), tx]).toString('hex');
    }
    throw new Error(`not served: ${method}`);
  };
  const fetcher = async (_u, init) => {
    const b = JSON.parse(init.body);
    posts.push(Array.isArray(b) ? b.map((q) => q.method) : [b.method]);
    if (failOnce && !failed && Array.isArray(b) && b[0].method === failOnce) { failed = true; return new Response('work queue depth exceeded', { status: 503 }); }
    const one = (q) => { try { return { id: q.id, result: answer(q), error: null }; } catch (e) { return { id: q.id, result: null, error: { code: -8, message: e.message } }; } };
    const text = JSON.stringify(Array.isArray(b) ? b.map(one) : one(b));
    sizes.push({ methods: Array.isArray(b) ? b.length : 1, first: Array.isArray(b) ? b[0].method : b.method, bytes: text.length });
    return new Response(text, { status: 200 });
  };
  return { call: bitcoindRpc({ url: 'http://x/', fetcher, readCookie: () => 'u:p' }), posts, sizes };
}

test('#1968 refute 1: the FIRST getblock batch of a view stays near BLOCK_BATCH_BYTES on a chain of large blocks', async () => {
  const chain = chainOf(100);
  const node = nodeOver(() => chain, { bigBytes: 1_000_000 });   // 1 MB blocks; testnet4 and mainnet blocks reach ~4 MB raw (256 MB of hex for 32)
  const v = await blocksOver(node.call, 0, 99, { cache: blockCache() });
  assert.equal(v.blocks.length, 100);
  const blockReqs = node.sizes.filter((s) => s.first === 'getblock' && s.methods > 1);
  console.log('  getblock batches [calls, bytes]', JSON.stringify(blockReqs.map((s) => [s.methods, s.bytes])));
  const max = Math.max(...blockReqs.map((s) => s.bytes));
  assert.ok(max <= BLOCK_BATCH_BYTES + 2 * 1_000_100 + 4096, `one request answered ${max} bytes of hex, ${(max / BLOCK_BATCH_BYTES).toFixed(1)}x the ${BLOCK_BATCH_BYTES} budget`);
});

test('#1968 refute 1b: a second view over other large blocks starts again at 32 blocks a request (the budget is not kept across views)', async () => {
  const chain = chainOf(200);
  const node = nodeOver(() => chain, { bigBytes: 1_000_000 });
  const cache = blockCache();
  await blocksOver(node.call, 0, 99, { cache });
  node.sizes.length = 0;
  await blocksOver(node.call, 100, 199, { cache });
  const blockReqs = node.sizes.filter((s) => s.first === 'getblock' && s.methods > 1);
  console.log('  second view getblock batches [calls, bytes]', JSON.stringify(blockReqs.map((s) => [s.methods, s.bytes])));
  const max = Math.max(...blockReqs.map((s) => s.bytes));
  assert.ok(max <= BLOCK_BATCH_BYTES + 2 * 1_000_100 + 4096, `the second view's request answered ${max} bytes of hex`);
});
