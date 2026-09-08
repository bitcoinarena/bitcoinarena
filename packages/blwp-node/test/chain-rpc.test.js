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
import { blockOf } from '../../protocol/tools/bond.js';
import { hash256, blockHashOf, HEADER_BYTES } from '../../protocol/src/chain.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

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
