// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S LIQUIDATION HOOK (§23A.5 step 2): the template's own claimLiquidations, run on stubs - a seat lists the arbitration set's
// liquidation event of a federation this browser holds, the page presents that wallet and collects the payouts naming its key at the
// doors the signed events name; nothing happens when no seat lists one, and a seat's own list is not read (kanban #1148).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const a = HTML.indexOf('    async function claimLiquidations() {');
const slice = HTML.slice(a, HTML.indexOf('\n    }\n', a) + 7);
const FED = 'ab'.repeat(32), SAFE = 'ef'.repeat(32);

const ev = (fid) => ({ event: { kind: 'liquidation', network: 'testnet4', federation: fid, door: 'https://arb.example', halt: { height: 100 }, firstMs: 1, atMs: 1 }, signatures: [] });
const run = async (events, store = new Map(), liquidations = []) => {
  const calls = [];
  const window = { ARENA_LEDGER_LOBBY: { nodes: ['https://seat-1'] }, ARENA_CURVE: { verify: () => true }, ARENA_FED_LOADS: new Map([[FED, { federation: FED, invite: 'inv-a', height: 120 }], [SAFE, { federation: SAFE, invite: 'inv-safe', height: 121 }]]),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_READ_BALANCE: () => calls.push('balance') };
  const ARENACLIENT = { presentNotes: async (o) => { const f = o.held[0]; calls.push(['present', f, o.payoutPk, (await o.walletFor(FED)).invite, o.network, o.height, o.events.length, typeof o.verify]); return f === FED ? [{ federation: FED, ok: true, accepted: [1] }] : [{ federation: f, ok: true, nothing: true }]; },
    liquidationDoors: (o) => { calls.push(['doors', o.events.length]); return o.events.length ? ['https://arb.example'] : []; },
    collectLiquidationPayouts: async (o) => { calls.push(['collect', o.listed.payouts.length, (await o.clientFor(SAFE)).invite]); return [{ ok: true, msat: '768000' }]; },
    liquidationKeyFor: () => ({ payoutPk: '02' + '11'.repeat(32) }), ledgerFederations: () => [FED],
    openPlayerWallet: async (o) => ({ invite: o.invite }), fromHex: (h) => h };
  const fetch = async (url) => { calls.push(['fetch', url]);
    if (url.endsWith('/liquidations')) return { ok: true, json: async () => ({ liquidations, events }) };
    if (url.endsWith('/liquidation-payouts')) return { ok: true, json: async () => ({ payouts: [{}, {}] }) };
    return { ok: false }; };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'walletSeed', 'vault', 'fetch', 'console'], [slice], 'return claimLiquidations;');
  await fn(window, ARENACLIENT, () => new Uint8Array(32), () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }), fetch, { log: () => {}, warn: () => {} })();
  return calls;
};

test('a liquidation of a held federation: the wallet presented with this seed\'s key, the payouts collected in the federation they were paid in', async () => {
  const calls = await run([ev(FED), ev('cd'.repeat(32))]);
  assert.deepEqual(calls.filter((c) => c[0] === 'present').map((c) => c[1]), [FED, 'cd'.repeat(32)], 'every liquidating federation: a browser restored from the 24 words has no ledger (kanban #1093 part 9)');
  assert.deepEqual(calls.filter((c) => c[0] === 'present')[0], ['present', FED, '02' + '11'.repeat(32), 'inv-a', 'testnet4', 121, 2, 'function'], 'the signed events, the chain, the tip and the page\'s signature check');
  assert.deepEqual(calls.filter((c) => c[0] === 'fetch').map((c) => c[1]), ['https://seat-1/liquidations', 'https://arb.example/liquidation-payouts']);
  assert.deepEqual(calls.filter((c) => c[0] === 'collect'), [['collect', 2, 'inv-safe']]);
  assert.ok(calls.includes('balance'));
});

test('any device (kanban #1093 part 9): a liquidating federation this seed holds nothing in is opened once, a held one every time', async () => {
  const store = new Map(), list = [ev(FED), ev('cd'.repeat(32))];
  await run(list, store);
  assert.ok(store.has('arena-liquidation-checked-' + 'cd'.repeat(32)), 'found empty, so kept as checked');
  assert.ok(!store.has('arena-liquidation-checked-' + FED), 'a federation with a ledger row is never marked');
  const again = await run(list, store);
  assert.deepEqual(again.filter((c) => c[0] === 'present').map((c) => c[1]), [FED]);
});

test('no liquidation listed: nothing presented, nothing asked of an arbitration set', async () => {
  const calls = await run([]);
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['fetch']);
});

test('a seat\'s own list with a claims URL and no signed event (kanban #1148): nothing presented, no door asked', async () => {
  const calls = await run([], new Map(), [{ federation: FED, claims: 'https://attacker.example/liquidation-claims', liquidatesAt: 0, lateClaimsUntil: 1e9 }]);
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['fetch']);
  assert.ok(!calls.some((c) => Array.isArray(c) && String(c[1]).includes('attacker')));
});
