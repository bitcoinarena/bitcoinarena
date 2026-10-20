// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE, READ FROM ITS GUARDIANS (§23A.3): each guardian's stock wallet_summary over its
// JSON-RPC WebSocket; kept only when a threshold of them name one sum. A fake WebSocket per endpoint answers as a guardian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReserve, reserveOfSummary, routedEndpoint } from '../src/federation-reserve.js';
import { parseRoutes } from '../src/fetch-routes.js';

const summary = (amounts) => ({ spendable_utxos: amounts.map((a, i) => ({ amount: a, outpoint: `${'00'.repeat(32)}:${i}` })),
  unconfirmed_change_utxos: [], unconfirmed_peg_out_txos: [{ amount: 999 }], unsigned_change_utxos: [{ amount: 7 }], unsigned_peg_out_txos: [] });
const fakeWS = (byEndpoint) => class {
  constructor(url) { this.url = url; this.on = {}; setTimeout(() => (byEndpoint[url] === 'down' ? this.on.error?.({}) : this.on.open?.()), 1); }
  addEventListener(k, f) { this.on[k] = f; }
  send(m) {
    const { id, method } = JSON.parse(m);
    const s = byEndpoint[this.url];
    if (s === 'silent') return;   // open, and never answers
    setTimeout(() => this.on.message?.({ data: JSON.stringify(method === 'module_3_wallet_summary' && s && s !== 'down' ? { jsonrpc: '2.0', id, result: s } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) }), 1);
  }
  close() {}
};

test('the reserve is the sum a threshold of guardians name - spendable plus the federation\'s own change, not peg-outs', async () => {
  assert.equal(reserveOfSummary(summary([250000, 250000, 150000])), 650007n);
  const eps = [1, 2, 3, 4, 5, 6, 7].map((i) => `ws://g${i}`);
  const all = Object.fromEntries(eps.map((e) => [e, summary([250000, 250000, 150000])]));
  const ok = await readReserve({ endpoints: eps, threshold: 5, WS: fakeWS(all) });
  assert.deepEqual([ok.ok, ok.reserveSats, ok.agreeing, ok.moduleId], [true, 650007n, 5, 3], 'it answers once five agree');
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
  assert.deepEqual([ok.ok, ok.reserveSats, ok.agreeing, ok.moduleId], [true, 1098919n, 5, 2]);
  const none = await readReserve({ endpoints: eps, threshold: 5, WS: v2(Object.fromEntries(eps.map((e) => [e, null]))) });
  assert.deepEqual([none.ok, none.reserveSats], [true, 0n]);
});

test('a guardian endpoint no override names is routed by the seat\'s ARENA_ROUTE_MAP, its scheme carried over (kanban #549: a successor\'s guardian-next)', () => {
  const routes = parseRoutes('https://seat.example.com/fed2-1=http://198.51.100.7:6221,https://tn4.bitcoin-arena.io/guardian-2=https://tn4.example/g2');
  const overrides = new Map([['wss://seat.example.com/fed2-1/guardian', 'ws://127.0.0.1:7221']]);
  assert.equal(routedEndpoint('wss://seat.example.com/fed2-1/guardian', { overrides, routes }), 'ws://127.0.0.1:7221', 'an override still wins');
  assert.equal(routedEndpoint('wss://seat.example.com/fed2-1/guardian-next', { overrides, routes }), 'ws://198.51.100.7:6221/guardian-next');
  assert.equal(routedEndpoint('wss://tn4.bitcoin-arena.io/guardian-2/', { overrides, routes }), 'wss://tn4.example/g2');
  assert.equal(routedEndpoint('wss://seat.example.com/fed2-10/guardian', { overrides, routes }), 'wss://seat.example.com/fed2-10/guardian', 'a path boundary: fed2-10 is not fed2-1');
  assert.equal(routedEndpoint('wss://elsewhere.example/g', { overrides, routes }), 'wss://elsewhere.example/g');
  assert.equal(routedEndpoint('wss://x/g', { overrides: new Map(), routes: [] }), 'wss://x/g');
});

test('a guardian that never answers does not hold the reading: it answers once a threshold agree, not at the timeout (kanban #549)', async () => {
  const eps = [1, 2, 3, 4, 5, 6, 7].map((i) => `ws://g${i}`);
  const all = Object.fromEntries(eps.map((e) => [e, summary([100000])]));
  const t0 = Date.now();
  const r = await readReserve({ endpoints: eps, threshold: 5, timeoutMs: 5000, WS: fakeWS({ ...all, 'ws://g7': 'silent' }) });
  assert.deepEqual([r.ok, r.reserveSats, r.agreeing], [true, 100007n, 5]);
  assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms, not after the 5 s timeout`);
  // and a refusal still waits for every answer: three silent, four agree - fewer than five, said when the timeout ends
  const no = await readReserve({ endpoints: eps, threshold: 5, timeoutMs: 300, WS: fakeWS({ ...all, 'ws://g5': 'silent', 'ws://g6': 'silent', 'ws://g7': 'silent' }) });
  assert.deepEqual([no.ok, no.why], [false, '4 of 7 guardians named one reserve, and 5 must']);
});
