// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A COIN THE MEMPOOL ALREADY SPENDS IS NOT OFFERED (kanban #577, 2026-10-22: the custody agent's peg-in re-spent the coin its own
// unconfirmed guardian_of update had spent, and bitcoind refused it as a cheaper replacement every minute).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinsOf } from '../src/wallet.js';

test('coinsOf on bitcoind leaves out a confirmed coin an unconfirmed transaction already spends', async () => {
  const spentInMempool = 'aa'.repeat(32), free = 'bb'.repeat(32);
  const asked = [];
  const fetcher = async (url, { body }) => {
    const { method, params } = JSON.parse(body); asked.push(method);
    const result = method === 'getblockcount' ? 157264
      : method === 'scantxoutset' ? { unspents: [{ txid: spentInMempool, vout: 0, amount: 0.003, height: 157263 }, { txid: free, vout: 1, amount: 0.002, height: 157263 }] }
        : method === 'gettxout' ? (params[0] === spentInMempool ? null : { value: 0.002 }) : null;
    return { status: 200, json: async () => ({ result, error: null }) };
  };
  const r = await coinsOf({ kind: 'core', url: 'http://127.0.0.1:1', user: 'u', password: 'p' }, new Uint8Array([0x51]), { fetcher });
  assert.deepEqual(r.coins.map((c) => c.txid), [free]);
  assert.equal(r.coins[0].sats, 200000);
  assert.ok(asked.filter((m) => m === 'gettxout').length === 2, 'each coin asked with the mempool');
});

test('a scan another reader of the same Bitcoin Core is running is waited for, not failed (kanban #577)', async () => {
  let scans = 0;
  const fetcher = async (url, { body }) => {
    const { method } = JSON.parse(body);
    if (method === 'scantxoutset' && ++scans < 3) return { status: 500, json: async () => ({ result: null, error: { code: -8, message: 'Scan already in progress, use action "abort" or "status"' } }) };
    const result = method === 'getblockcount' ? 157279 : method === 'scantxoutset' ? { unspents: [{ txid: 'cc'.repeat(32), vout: 0, amount: 0.00523, height: 157279 }] }
      : method === 'gettxout' ? { value: 0.00523 } : null;
    return { status: 200, json: async () => ({ result, error: null }) };
  };
  const chain = { kind: 'core', url: 'http://127.0.0.1:1', user: 'u', password: 'p' };
  const r = await coinsOf(chain, new Uint8Array([0x51]), { fetcher, scanPauseMs: 1 });
  assert.equal(scans, 3, 'asked again until the other scan was done');
  assert.equal(r.coins[0].sats, 523000);
  scans = -100;   // busy for good: still a failure after its tries, with bitcoind's words
  await assert.rejects(coinsOf(chain, new Uint8Array([0x51]), { fetcher, scanPauseMs: 1, scanTries: 4 }), /Scan already in progress/);
});
