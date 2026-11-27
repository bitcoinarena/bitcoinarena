// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3889: how deep the advertisement update is, from Bitcoin Core without a txindex - the mempool, the blocks since it was sent, then
// only the tip once its block is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { txDepth } from '../src/wallet.js';

const TX = 'cc'.repeat(32);
function core({ tip, inBlock = null, mempool = false }) {
  const calls = [];
  const fetcher = async (_u, o) => {
    const { method, params } = JSON.parse(o.body); calls.push(method);
    const ok = (result) => new Response(JSON.stringify({ result, error: null }));
    if (method === 'getblockcount') return ok(tip);
    if (method === 'getrawtransaction') return mempool ? ok({ txid: TX }) : new Response(JSON.stringify({ result: null, error: { message: 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.' } }));
    if (method === 'getblockhash') return ok(`h${params[0]}`);
    if (method === 'getblock') return ok({ tx: params[0] === `h${inBlock}` ? ['aa', TX] : ['aa'] });
    throw new Error(method);
  };
  return { chain: { kind: 'core', url: 'http://127.0.0.1:1', user: 'u', password: 'p' }, fetcher, calls };
}

test('in the mempool: 0; in block 103 at tip 105: 3 and its height; with the height known: the tip only; not found: null', async () => {
  let c = core({ tip: 105, mempool: true });
  assert.deepEqual(await txDepth(c.chain, TX, { sinceTip: 100, fetcher: c.fetcher }), { depth: 0, height: null, tip: 105 });
  c = core({ tip: 105, inBlock: 103 });
  assert.deepEqual(await txDepth(c.chain, TX, { sinceTip: 100, fetcher: c.fetcher }), { depth: 3, height: 103, tip: 105 });
  c = core({ tip: 110 });
  assert.deepEqual(await txDepth(c.chain, TX, { height: 103, fetcher: c.fetcher }), { depth: 8, height: 103, tip: 110 });
  assert.deepEqual(c.calls, ['getblockcount']);
  c = core({ tip: 105 });
  assert.equal((await txDepth(c.chain, TX, { sinceTip: 100, fetcher: c.fetcher })).depth, null);
});
