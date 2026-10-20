// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ANY LISTED GATEWAY, THE NEXT AFTER A TIMEOUT (spec §23.1): the order (the lobby's first, then the
// federation's, each once), a gateway that makes no invoice passed over, an invoice that ends Expired or stays unclaimed
// followed by the next gateway's - the first still payable - and the deposit offer doing it end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayOrder, federationGateways, invoiceThroughGateways, followWithFailover, depositOffer, useSeatedGateways, noteClientFederation, seatedGatewaysOf, openPlayerWallet } from '../src/page-lock.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A lock client whose gateways behave as `plan` says: 'hang' (never answers), 'throw', or { end, afterMs } for the invoice. */
function fakeClient(plan, listed = []) {
  const ops = new Map(); let n = 0; const asked = [];
  return {
    asked,
    gateways: async () => JSON.stringify(listed),
    receive: async (msat, gw) => {
      asked.push(gw);
      const p = plan[gw];
      if (p === 'hang') return new Promise(() => {});
      if (p === 'throw' || !p) throw new Error(`${gw} refused`);
      const op = `op${++n}`; ops.set(op, p);
      return JSON.stringify({ invoice: `lntb-${gw}-${msat}`, operation: op });
    },
    awaitReceive: async (op) => { const p = ops.get(op); if (p.end === 'never') return new Promise(() => {}); await wait(p.afterMs || 0); return p.end; },
  };
}

test('the order: the lobby\'s gateway first, then the federation\'s, each once whatever its case or trailing slash', async () => {
  assert.deepEqual(gatewayOrder(['https://B/'], ['https://a', 'https://b', 'https://c/']), ['https://B/', 'https://a', 'https://c/']);
  assert.deepEqual(gatewayOrder([], []), []);
  const c = fakeClient({}, ['https://x', 'https://y']);
  assert.deepEqual(await federationGateways(c), ['https://x', 'https://y']);
  assert.deepEqual(await federationGateways({ gateways: async () => { throw new Error('old wasm'); } }), []);
  assert.deepEqual(await federationGateways({}), [], 'a lock client without gateways() names none');
});

test('a gateway that makes no invoice in time, or refuses, is passed over at once; the next one\'s invoice is taken', async () => {
  const c = fakeClient({ A: 'hang', B: 'throw', C: { end: 'Claimed' } });
  const t0 = Date.now();
  const got = await invoiceThroughGateways(c, 1000n, ['A', 'B', 'C'], { timeoutMs: 50 });
  assert.equal(got.gateway, 'C');
  assert.equal(got.invoice, 'lntb-C-1000');
  assert.deepEqual(got.tried.map((t) => t.gateway), ['A', 'B']);
  assert.match(got.tried[0].why, /no answer in 0.05 s/);
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(invoiceThroughGateways(fakeClient({ A: 'throw' }), 1n, ['A'], { timeoutMs: 50 }), /no gateway made a deposit invoice: A \(A refused\)/);
  assert.equal((await invoiceThroughGateways(fakeClient({ '': { end: 'Claimed' } }), 1n, [])).gateway, '', 'none listed: the lock client picks');
});

test('an invoice that ends Expired gets the next gateway\'s; one never claimed gets the next after the timeout, both still watched', async () => {
  const c = fakeClient({ A: { end: 'Expired', afterMs: 10 }, B: { end: 'Claimed', afterMs: 30 } });
  const first = JSON.parse(await c.receive('500', 'A'));
  const shown = [], ended = [];
  await new Promise((done) => followWithFailover(c, { ...first, gateway: 'A' }, { amountMsat: 500n, order: ['A', 'B'], unclaimedMs: 5000, timeoutMs: 50,
    onInvoice: (n) => shown.push([n.gateway, n.failoverFrom, n.failoverWhy]), onEnd: (d, f, failover) => { ended.push([d.gateway, f, failover]); if (f === 'Claimed') done(); } }));
  assert.deepEqual(shown, [['B', 'A', 'it ended Expired']]);
  assert.deepEqual(ended, [['A', 'Expired', true], ['B', 'Claimed', false]]);

  const s = fakeClient({ A: { end: 'never' }, B: { end: 'Claimed', afterMs: 20 } });
  const one = JSON.parse(await s.receive('500', 'A'));
  const shown2 = [];
  await new Promise((done) => followWithFailover(s, { ...one, gateway: 'A' }, { amountMsat: 500n, order: ['A', 'B'], unclaimedMs: 60, timeoutMs: 50,
    onInvoice: (n) => shown2.push([n.gateway, n.failoverWhy]), onEnd: (d, f) => { if (f === 'Claimed') done(); } }));
  assert.deepEqual(shown2, [['B', 'not claimed in 0.06 s']]);

  const last = fakeClient({ A: { end: 'Expired' } });
  const only = JSON.parse(await last.receive('500', 'A'));
  const why = await new Promise((done) => followWithFailover(last, { ...only, gateway: 'A' }, { amountMsat: 500n, order: ['A'], timeoutMs: 50, unclaimedMs: 5000, onExhausted: done }));
  assert.match(why, /it ended Expired/, 'no gateway left is said, not waited on');
});

test('the deposit offer: the lobby\'s gateway refuses, the federation\'s next makes the invoice; claimed settles the offer', async () => {
  const c = fakeClient({ 'https://lobby': 'throw', 'https://fed-1': { end: 'Claimed', afterMs: 20 } }, ['https://fed-1', 'https://lobby']);
  const shown = [];
  const offer = depositOffer({ client: c, stakeMsat: 100000n, gateways: ['https://lobby'], onDeposit: (d) => shown.push(d.gateway) });
  const d = await offer.invoice(100000n);
  assert.equal(d.gateway, 'https://fed-1');
  assert.deepEqual(d.tried.map((t) => t.gateway), ['https://lobby']);
  assert.equal((await offer.claimed).gateway, 'https://fed-1');
  assert.deepEqual(c.asked, ['https://lobby', 'https://fed-1']);
  assert.deepEqual(shown, ['https://fed-1']);
});

// kanban #559 (spec §23A.9: "clients use those two first"): the federation's seated gateways come before the lobby's and the list
test('the seated gateways first: a deposit asks its federation\'s seated gateways before the lobby\'s and the federation\'s list', async () => {
  const F = 'ab'.repeat(32), G = 'cd'.repeat(32);
  const asked = [];
  useSeatedGateways(async (fid) => { asked.push(fid); return fid === F ? ['https://seat-1', 'https://seat-2'] : []; });
  try {
    const c = fakeClient({ 'https://seat-1': 'throw', 'https://seat-2': { end: 'Claimed', afterMs: 10 }, 'https://lobby': { end: 'Claimed' } }, ['https://fed-1', 'https://seat-2']);
    assert.deepEqual(await seatedGatewaysOf(c), [], 'a client whose federation is not known asks no seats');
    noteClientFederation(c, F.toUpperCase());
    assert.deepEqual(await seatedGatewaysOf(c), ['https://seat-1', 'https://seat-2']);
    const d = await depositOffer({ client: c, stakeMsat: 100000n, gateways: ['https://lobby'] }).invoice(100000n);
    assert.equal(d.gateway, 'https://seat-2');
    assert.deepEqual(c.asked, ['https://seat-1', 'https://seat-2'], 'the seated two before the lobby\'s');
    // openPlayerWallet notes the federation of the client it opens
    const opened = fakeClient({});
    const LockClient = { join: async () => opened };
    await openPlayerWallet({ federationId: Uint8Array.from(Buffer.from(G, 'hex')), invite: 'fed1x', seed: new Uint8Array(32).fill(3), LockClient, storage: null });
    await seatedGatewaysOf(opened);
    assert.equal(asked[asked.length - 1], G);
    // a lookup that hangs costs 3 s at most and names none
    useSeatedGateways(() => new Promise(() => {}));
    const t0 = Date.now(); assert.deepEqual(await seatedGatewaysOf(c), []); assert.ok(Date.now() - t0 < 4000);
  } finally { useSeatedGateways(null); }
});
