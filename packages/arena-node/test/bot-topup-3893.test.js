// kanban #3893: a test bot's top-up goes over the next working gateway when one gateway (its LND) is down or its invoice cannot be paid
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewaysOf, topUp, tryOrder, KNOWN_GATEWAYS } from '../tools/bot-topup.mjs';

test('gatewaysOf: the named gateway first, then the other known ones once each', () => {
  assert.deepEqual(gatewaysOf({ GATEWAY: 'https://gw-a.bitcoin-arena.io' }), KNOWN_GATEWAYS);
  assert.deepEqual(gatewaysOf({ GATEWAYS: 'https://gw-c.bitcoin-arena.io/,https://x.example/' }).slice(0, 3), ['https://gw-c.bitcoin-arena.io/', 'https://x.example/', KNOWN_GATEWAYS[0]]);
  assert.deepEqual(gatewaysOf({ GATEWAYS: 'https://x.example', GATEWAYS_ONLY: '1' }), ['https://x.example/']);
  assert.deepEqual(tryOrder(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  assert.deepEqual(tryOrder(['a', 'b'], 'z'), ['a', 'b']);
});

test('gw-a down (its LND refuses): the invoice is made at gw-b and paid', async () => {
  const asked = [], logs = [];
  const r = await topUp({ gateways: ['A', 'B', 'C'], log: (x) => logs.push(x),
    receive: async (gw) => { if (gw === 'A') throw new Error('Failed to connect to gateway'); return { invoice: `inv-${gw}`, operation: `op-${gw}` }; },
    ask: async (inv) => { asked.push(inv); return { ok: true }; },
    awaitReceive: async (op) => `Claimed ${op}` });
  assert.equal(r.ok, true); assert.equal(r.gateway, 'B'); assert.equal(r.final, 'Claimed op-B');
  assert.deepEqual(asked, ['inv-B']);
  assert.equal(r.tried.length, 1); assert.match(r.tried[0].why, /Failed to connect/);
  assert.equal(logs[0].step, 'top-up gateway failed');
});

test('the faucet cannot pay one gateway\'s invoice: the next gateway is asked; all fail -> ok false with every reason', async () => {
  const r = await topUp({ gateways: ['A', 'B', 'C'],
    receive: async (gw) => ({ invoice: gw, operation: gw }),
    ask: async (inv) => (inv === 'C' ? { ok: true } : { ok: false, why: 'could not pay just now' }),
    awaitReceive: async () => 'Claimed' });
  assert.equal(r.gateway, 'C'); assert.equal(r.tried.length, 2);
  const none = await topUp({ gateways: ['A', 'B'], receive: async () => { throw new Error('down'); }, ask: async () => ({ ok: true }), awaitReceive: async () => 'x' });
  assert.equal(none.ok, false); assert.deepEqual(none.tried.map((t) => t.gateway), ['A', 'B']);
});

test('the gateway that worked last is asked first', async () => {
  const order = [];
  await topUp({ gateways: ['A', 'B', 'C'], prefer: 'C', receive: async (gw) => { order.push(gw); return { invoice: gw, operation: gw }; }, ask: async () => ({ ok: true }), awaitReceive: async () => 'ok' });
  assert.deepEqual(order, ['C']);
});

test('a claim that never comes: after claimMs the next gateway is asked', async () => {
  const r = await topUp({ gateways: ['A', 'B'], claimMs: 50,
    receive: async (gw) => ({ invoice: gw, operation: gw }), ask: async () => ({ ok: true }),
    awaitReceive: (op) => (op === 'A' ? new Promise(() => {}) : Promise.resolve('Claimed')) });
  assert.equal(r.ok, true); assert.equal(r.gateway, 'B'); assert.deepEqual(r.tried.map((t) => [t.gateway, t.step]), [['A', 'claim']]);
  assert.match(r.tried[0].why, /no claim in 0 s/);
});

// kanban #3893 follow-up (measured 2026-11-27 20:00-20:20Z): gw-c was not joined to 4dc88be7 ("No federation available for prefix 4dc88be7") and
// the wallet could not reach its guardians, yet the faucet paid gw-a's and gw-b's invoices each pass - 6000 sat a time into contracts nobody claimed.
test('#3893b: only the gateways the federation lists are asked; the others are reported, not tried', async () => {
  const asked = [], logs = [];
  const r = await topUp({ gateways: ['https://gw-c.x/', 'https://gw-a.x/'], log: (x) => logs.push(x),
    listed: async () => ['https://gw-a.x/', 'https://gw-b.x'],
    receive: async (gw) => { asked.push(gw); return { invoice: gw, operation: gw }; }, ask: async () => ({ ok: true }), awaitReceive: async () => 'Claimed' });
  assert.equal(r.ok, true); assert.equal(r.gateway, 'https://gw-a.x/');
  assert.deepEqual(asked, ['https://gw-a.x/']);
  assert.deepEqual(r.tried.map((t) => [t.gateway, t.step]), [['https://gw-c.x/', 'not joined']]);
  assert.ok(logs.some((l) => l.gateway === 'https://gw-c.x/' && l.stage === 'not joined'));
});

test('#3893b: a federation the wallet cannot reach is not paid into - no invoice, no faucet, the reason reported', async () => {
  let asked = 0, invoices = 0;
  const r = await topUp({ gateways: ['A', 'B'], listMs: 50,
    listed: () => new Promise(() => {}),
    receive: async (gw) => { invoices++; return { invoice: gw, operation: gw }; }, ask: async () => { asked++; return { ok: true }; }, awaitReceive: async () => 'Claimed' });
  assert.equal(r.ok, false); assert.equal(asked, 0); assert.equal(invoices, 0);
  assert.deepEqual(r.tried.map((t) => t.step), ['federation']);
  assert.match(r.tried[0].why, /guardians not reachable/);
  const thrown = await topUp({ gateways: ['A'], listed: async () => { throw new Error('Failed to download client config'); },
    receive: async () => { invoices++; return {}; }, ask: async () => ({ ok: true }), awaitReceive: async () => 'x' });
  assert.equal(thrown.ok, false); assert.equal(invoices, 0); assert.match(thrown.tried[0].why, /Failed to download/);
});
