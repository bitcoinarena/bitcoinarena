// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S LIQUIDATION HOOK (§23A.5 step 2): the template's own claimLiquidations, run on stubs - a seat lists a
// liquidation of a federation this browser holds, the page presents that wallet and collects the payouts naming its key;
// nothing happens when no seat lists one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const a = HTML.indexOf('    async function claimLiquidations() {');
const slice = HTML.slice(a, HTML.indexOf('\n    }\n', a) + 7);
const FED = 'ab'.repeat(32), SAFE = 'ef'.repeat(32);

// kanban #1148: the page reads the arbitration set's signed events, never a seat's own list
const ev = (fid) => ({ event: { kind: 'liquidation', network: 'testnet4', federation: fid, door: 'https://arb.example', halt: { height: 100 }, firstMs: 1, atMs: 1 }, signatures: [] });
const run = async (events, liquidations = []) => {
  const calls = [];
  const window = { ARENA_LEDGER_LOBBY: { nodes: ['https://seat-1'] }, ARENA_CURVE: { verify: () => true }, ARENA_FED_LOADS: new Map([[FED, { federation: FED, invite: 'inv-a', height: 120 }], [SAFE, { federation: SAFE, invite: 'inv-safe', height: 121 }]]),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_READ_BALANCE: () => calls.push('balance') };
  const ARENACLIENT = { presentNotes: async (o) => { calls.push(['present', o.held[0], o.payoutPk, (await o.walletFor(FED)).invite, o.network, o.height, o.events.length, typeof o.verify]); return [{ federation: FED, ok: true, accepted: [1] }]; },
    liquidationDoors: (o) => { calls.push(['doors', o.events.length]); return o.events.length ? ['https://arb.example'] : []; },
    collectLiquidationPayouts: async (o) => { calls.push(['collect', o.listed.payouts.length, (await o.clientFor(SAFE)).invite]); return [{ ok: true, msat: '768000' }]; },
    liquidationKeyFor: () => ({ payoutPk: '02' + '11'.repeat(32) }), ledgerFederations: () => [FED],
    openPlayerWallet: async (o) => ({ invite: o.invite }), fromHex: (h) => h };
  const fetch = async (url) => { calls.push(['fetch', url]);
    if (url.endsWith('/liquidations')) return { ok: true, json: async () => ({ liquidations, events }) };
    if (url.endsWith('/liquidation-payouts')) return { ok: true, json: async () => ({ payouts: [{}, {}] }) };
    return { ok: false }; };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'walletSeed', 'vault', 'fetch', 'console'], [slice], 'return claimLiquidations;');
  await fn(window, ARENACLIENT, () => new Uint8Array(32), () => ({}), fetch, { log: () => {}, warn: () => {} })();
  return calls;
};

test('a liquidation of a held federation: the wallet presented with this seed\'s key, the payouts collected in the federation they were paid in', async () => {
  const calls = await run([ev(FED), ev('cd'.repeat(32))]);
  assert.deepEqual(calls.filter((c) => c[0] === 'present'), [['present', FED, '02' + '11'.repeat(32), 'inv-a', 'testnet4', 121, 2, 'function']], 'only the held federation, with the signed events, the chain, the tip and the signature check');
  assert.deepEqual(calls.filter((c) => c[0] === 'fetch').map((c) => c[1]), ['https://seat-1/liquidations', 'https://arb.example/liquidation-payouts']);
  assert.deepEqual(calls.filter((c) => c[0] === 'collect'), [['collect', 2, 'inv-safe']]);
  assert.ok(calls.includes('balance'));
});

test('no liquidation listed: nothing presented, nothing asked of an arbitration set', async () => {
  const calls = await run([]);
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['fetch']);
});

test('a seat\'s own list with a claims URL and no signed event (kanban #1148): nothing presented, no door asked', async () => {
  const calls = await run([], [{ federation: FED, claims: 'https://attacker.example/liquidation-claims', liquidatesAt: 0, lateClaimsUntil: 1e9 }]);
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['fetch']);
  assert.ok(!calls.some((c) => Array.isArray(c) && String(c[1]).includes('attacker')));
});

// KANBAN #1234 (audit 3 #1210 FIXES-3): one seat's unsigned row of a larger atMs replaced the signed row before anything checked a signature
const runSeats = async (bySeat) => {
  const handed = [];
  const window = { ARENA_LEDGER_LOBBY: { nodes: Object.keys(bySeat) }, ARENA_CURVE: { verify: () => true }, ARENA_FED_LOADS: new Map([[FED, { federation: FED, invite: 'inv-a', height: 120 }]]),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }) };
  // the client's own rule, in short: the newest row that is signed stands
  const stands = (events) => events.filter((e) => (e.signatures || []).includes('good')).sort((a, b) => Number(b.event.atMs) - Number(a.event.atMs))[0] || null;
  const ARENACLIENT = { presentNotes: async (o) => { handed.push(['present', o.held[0], o.events.length, !!stands(o.events)]); return [{ federation: o.held[0], ok: !!stands(o.events), accepted: [] }]; },
    liquidationDoors: (o) => { const st = stands(o.events); handed.push(['doors', st ? 1 : 0]); return st ? [st.event.door] : []; },
    collectLiquidationPayouts: async () => { handed.push(['collect']); return []; },
    liquidationKeyFor: () => ({ payoutPk: '02' + '11'.repeat(32) }), ledgerFederations: () => [FED],
    openPlayerWallet: async (o) => ({ invite: o.invite }), fromHex: (h) => h };
  const fetch = async (url) => {
    const seat = Object.keys(bySeat).find((u) => url.startsWith(u));
    if (seat && url.endsWith('/liquidations')) return { ok: true, json: async () => ({ events: bySeat[seat] }) };
    if (url.endsWith('/liquidation-payouts')) { handed.push(['payouts', url]); return { ok: true, json: async () => ({ payouts: [] }) }; }
    return { ok: false }; };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'walletSeed', 'vault', 'fetch', 'console'], [slice], 'return claimLiquidations;');
  await fn(window, ARENACLIENT, () => new Uint8Array(32), () => ({ getItem: () => null, setItem: () => {} }), fetch, { log: () => {}, warn: () => {} })();
  return handed;
};
const signed = { ...ev(FED), signatures: ['good'] };
const forged = (atMs) => ({ event: { ...ev(FED).event, door: 'https://forger.example', atMs }, signatures: [] });

test('#1234 a seat\'s unsigned row of a larger atMs does not hide the signed liquidation: the signed row is presented, its door read', async () => {
  for (const [name, bySeat] of [
    ['the signed seat first', { 'https://seat-1': [signed], 'https://seat-2': [forged(1e15)] }],
    ['the forging seat first, atMs "9e99"', { 'https://seat-1': [forged('9e99')], 'https://seat-2': [signed] }],
    ['the forging seat floods 50 rows', { 'https://seat-1': Array.from({ length: 50 }, (_, i) => forged(1e15 + i)), 'https://seat-2': [signed] }],
  ]) {
    const h = await runSeats(bySeat);
    console.log(`  MEASURED #1234 ${name}:`, JSON.stringify(h));
    assert.deepEqual(h.filter((x) => x[0] === 'present').map((x) => [x[1], x[3]]), [[FED, true]], `${name}: presented once, with the signed row`);
    assert.deepEqual(h.filter((x) => x[0] === 'payouts').map((x) => x[1]), ['https://arb.example/liquidation-payouts'], `${name}: the signed door read, never the forger's`);
    assert.ok(h.find((x) => x[0] === 'present')[2] <= 5, `${name}: at most 4 rows a seat`);
  }
  const same = await runSeats({ 'https://seat-1': [signed], 'https://seat-2': [signed], 'https://seat-3': [signed] });
  assert.equal(same.find((x) => x[0] === 'present')[2], 1, 'the same row from three seats is one row');
});
