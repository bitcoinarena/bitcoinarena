// kanban #1489 refute of #3029: variants that the fix is expected to hold (seat lie in other encodings, deposit order, honest path)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pl from '../src/page-lock.js';

const F = 'cc'.repeat(32);
const HONEST = 'https://gw-honest.example/', OTHER = 'https://gw-other.example';
const fake = (listed) => ({ gateways: async () => JSON.stringify(listed) });

test('encodings of a gateway the federation does not list are all dropped', async () => {
  const lies = ['https://evil.example/', 'HTTPS://EVIL.EXAMPLE', ' https://evil.example ', 'https://gw-honest.example@evil.example/',
    'https://gw-honest.example.evil.example/', 'https://gw-honest.example/../', 'https://evil.example/#https://gw-honest.example/', 'https://gw-honest.example:444/'];
  pl.useSeatedGateways(async () => ({ answers: [lies, lies] }));   // kanban #3183: two seats' answers
  const c = fake([HONEST, OTHER]); pl.noteClientFederation(c, F);
  const got = await pl.seatedGatewaysOf(c);
  console.log('kept', JSON.stringify(got));
  assert.deepEqual(got, []);
  pl.useSeatedGateways(null);
});

test('a lookup answering a non-array, a thrown error, or never answering yields no seated gateway', async () => {
  for (const l of [async () => 'https://evil.example/', async () => { throw new Error('x'); }, async () => ({ 0: 'https://evil.example/', length: 1 })]) {
    pl.useSeatedGateways(l);
    const c = fake([HONEST]); pl.noteClientFederation(c, F);
    assert.deepEqual(await pl.seatedGatewaysOf(c), []);
  }
  pl.useSeatedGateways(null);
});

test('honest: a seated gateway the federation lists is tried first, in the seat\'s order, even with other case/slash', async () => {
  pl.useSeatedGateways(async () => ({ answers: [['https://GW-OTHER.example/', HONEST], ['https://GW-OTHER.example/', HONEST]] }));   // kanban #3183
  const c = fake([HONEST, OTHER]); pl.noteClientFederation(c, F);
  const s = await pl.seatedGatewaysOf(c);
  assert.deepEqual(s, ['https://GW-OTHER.example/', HONEST]);
  const order = pl.gatewayOrder([...s], await pl.federationGateways(c));
  assert.equal(order.length, 2);
  pl.useSeatedGateways(null);
});

test('deposit order: a lying seat cannot put its gateway in front of a deposit invoice', async () => {
  pl.useSeatedGateways(async () => ({ answers: [['https://evil.example/', HONEST], ['https://evil.example/', HONEST]] }));   // kanban #3183
  const asked = [];
  const c = { gateways: async () => JSON.stringify([OTHER, HONEST]), receive: async (m, gw) => { asked.push(gw); return JSON.stringify({ invoice: 'lntb1', operation: 'op' }); } };
  pl.noteClientFederation(c, F);
  const order = pl.gatewayOrder([...await pl.seatedGatewaysOf(c)], await pl.federationGateways(c));
  const got = await pl.invoiceThroughGateways(c, 1000n, order);
  assert.equal(got.gateway, HONEST);
  assert.ok(!asked.includes('https://evil.example/'));
  pl.useSeatedGateways(null);
});
