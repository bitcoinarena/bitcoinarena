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

const run = async (liquidations) => {
  const calls = [];
  const window = { ARENA_LEDGER_LOBBY: { nodes: ['https://seat-1'] }, ARENA_CURVE: {}, ARENA_FED_LOADS: new Map([[FED, { federation: FED, invite: 'inv-a' }], [SAFE, { federation: SAFE, invite: 'inv-safe' }]]),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_READ_BALANCE: () => calls.push('balance') };
  const ARENACLIENT = { presentNotes: async (o) => { calls.push(['present', o.liquidations[0].federation, o.payoutPk, (await o.walletFor(FED)).invite]); return [{ federation: FED, ok: true, accepted: [1] }]; },
    collectLiquidationPayouts: async (o) => { calls.push(['collect', o.listed.payouts.length, (await o.clientFor(SAFE)).invite]); return [{ ok: true, msat: '768000' }]; },
    liquidationKeyFor: () => ({ payoutPk: '02' + '11'.repeat(32) }), ledgerFederations: () => [FED],
    openPlayerWallet: async (o) => ({ invite: o.invite }), fromHex: (h) => h };
  const fetch = async (url) => { calls.push(['fetch', url]);
    if (url.endsWith('/liquidations')) return { ok: true, json: async () => ({ liquidations }) };
    if (url.endsWith('/liquidation-payouts')) return { ok: true, json: async () => ({ payouts: [{}, {}] }) };
    return { ok: false }; };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'walletSeed', 'vault', 'fetch', 'console'], [slice], 'return claimLiquidations;');
  await fn(window, ARENACLIENT, () => new Uint8Array(32), () => ({}), fetch, { log: () => {}, warn: () => {} })();
  return calls;
};

test('a liquidation of a held federation: the wallet presented with this seed\'s key, the payouts collected in the federation they were paid in', async () => {
  const calls = await run([{ federation: FED, claims: 'https://arb.example/liquidation-claims' }, { federation: 'cd'.repeat(32), claims: 'https://arb.example' }]);
  assert.deepEqual(calls.filter((c) => c[0] === 'present'), [['present', FED, '02' + '11'.repeat(32), 'inv-a']], 'only the held federation');
  assert.deepEqual(calls.filter((c) => c[0] === 'fetch').map((c) => c[1]), ['https://seat-1/liquidations', 'https://arb.example/liquidation-payouts']);
  assert.deepEqual(calls.filter((c) => c[0] === 'collect'), [['collect', 2, 'inv-safe']]);
  assert.ok(calls.includes('balance'));
});

test('no liquidation listed: nothing presented, nothing asked of an arbitration set', async () => {
  const calls = await run([]);
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['fetch']);
});
