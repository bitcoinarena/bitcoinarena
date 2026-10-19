// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE, READ FROM ITS GUARDIANS (§23A.3): each guardian's stock wallet_summary over its
// JSON-RPC WebSocket; kept only when a threshold of them name one sum. A fake WebSocket per endpoint answers as a guardian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReserve, reserveOfSummary } from '../src/federation-reserve.js';

const summary = (amounts) => ({ spendable_utxos: amounts.map((a, i) => ({ amount: a, outpoint: `${'00'.repeat(32)}:${i}` })),
  unconfirmed_change_utxos: [], unconfirmed_peg_out_txos: [{ amount: 999 }], unsigned_change_utxos: [{ amount: 7 }], unsigned_peg_out_txos: [] });
const fakeWS = (byEndpoint) => class {
  constructor(url) { this.url = url; this.on = {}; setTimeout(() => (byEndpoint[url] === 'down' ? this.on.error?.({}) : this.on.open?.()), 1); }
  addEventListener(k, f) { this.on[k] = f; }
  send(m) {
    const { id, method } = JSON.parse(m);
    const s = byEndpoint[this.url];
    setTimeout(() => this.on.message?.({ data: JSON.stringify(method === 'module_3_wallet_summary' && s && s !== 'down' ? { jsonrpc: '2.0', id, result: s } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) }), 1);
  }
  close() {}
};

test('the reserve is the sum a threshold of guardians name - spendable plus the federation\'s own change, not peg-outs', async () => {
  assert.equal(reserveOfSummary(summary([250000, 250000, 150000])), 650007n);
  const eps = [1, 2, 3, 4, 5, 6, 7].map((i) => `ws://g${i}`);
  const all = Object.fromEntries(eps.map((e) => [e, summary([250000, 250000, 150000])]));
  const ok = await readReserve({ endpoints: eps, threshold: 5, WS: fakeWS(all) });
  assert.deepEqual([ok.ok, ok.reserveSats, ok.agreeing, ok.moduleId], [true, 650007n, 7, 3]);
  // two lie, one is down: four honest are fewer than five
  const bad = { ...all, 'ws://g1': summary([1]), 'ws://g2': summary([1]), 'ws://g3': 'down' };
  const no = await readReserve({ endpoints: eps, threshold: 5, WS: fakeWS(bad) });
  assert.deepEqual([no.ok, no.why], [false, '4 of 7 guardians named one reserve, and 5 must']);
  // one lies and one is down: five honest
  const five = await readReserve({ endpoints: eps, threshold: 5, WS: fakeWS({ ...all, 'ws://g1': summary([1]), 'ws://g2': 'down' }) });
  assert.deepEqual([five.ok, five.reserveSats, five.agreeing], [true, 650007n, 5]);
});

// A walletv2 FEDERATION (the fork's regtestmeasured 2026-10-12: no guardian answered wallet_summary): its
// module answers federation_wallet - { value, outpoint, tweak }, or null before the first peg-in - and the value is the reserve
test('a walletv2 federation\'s reserve is its federation_wallet value, named by a threshold; none yet is 0', async () => {
  const v2 = (byEndpoint) => class {
    constructor(url) { this.url = url; this.on = {}; setTimeout(() => this.on.open?.(), 1); }
    addEventListener(k, f) { this.on[k] = f; }
    send(m) {
      const { id, method } = JSON.parse(m);
      const has = method === 'module_2_federation_wallet';
      setTimeout(() => this.on.message?.({ data: JSON.stringify(has ? { jsonrpc: '2.0', id, result: byEndpoint[this.url] } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) }), 1);
    }
    close() {}
  };
  const eps = [1, 2, 3, 4, 5, 6, 7].map((i) => `ws://v${i}`);
  const wallet = { value: 1098919, outpoint: `${'11'.repeat(32)}:0`, tweak: '22'.repeat(32) };
  const ok = await readReserve({ endpoints: eps, threshold: 5, WS: v2(Object.fromEntries(eps.map((e) => [e, wallet]))) });
  assert.deepEqual([ok.ok, ok.reserveSats, ok.agreeing, ok.moduleId], [true, 1098919n, 7, 2]);
  const none = await readReserve({ endpoints: eps, threshold: 5, WS: v2(Object.fromEntries(eps.map((e) => [e, null]))) });
  assert.deepEqual([none.ok, none.reserveSats], [true, 0n]);
});
