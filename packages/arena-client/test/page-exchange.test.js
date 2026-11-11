// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S E-CASH EXCHANGE (kanban #614): its own ARENA_EXCHANGE_INTO (index.html) hands the missing amount of the wallet's e-cash of
// another federation to a seat and receives the seat's e-cash of the round's federation - no Lightning, no dialog; a seat's refusal gives
// the notes back to the wallet; a seat that did not answer is asked again, with the same notes, at the next exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { exchangeRig, payingSeat, refusingSeat } from './ecash-1149-rig.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const A = '33'.repeat(32), B = '4d'.repeat(32);   // the rig's two federations

// THE EXCHANGE ITSELF (kanban #1149): one seat per bearer string, each step written first - ecash-1149-rig.js runs the page's own code
test('the round\'s federation lacks it: the other federation\'s e-cash to the one seat that offers it, the seat\'s e-cash of the round\'s back', async () => {
  const r = exchangeRig({ seats: { 'http://s1': refusingSeat({}), 'http://s2': payingSeat({ [B]: '500000' }) } });
  const said = await r.exchange({ to: B, needMsat: 100000n, nodes: ['http://s1', 'http://s2'] });
  assert.equal(said.ok, true, said.why);
  assert.equal(said.from, A);
  assert.deepEqual([...r.seen.values()], [['http://s2']], 'handed to the offering seat only');
  assert.deepEqual(r.log.map((x) => x.slice(0, 3)), [['send', '33', '100000'], ['receive', '4d', 'Success']]);
  assert.equal(r.kept().length, 0, 'nothing kept once received');
});

test('the one offering seat refuses outright: the notes come back to the wallet they left', async () => {
  const r = exchangeRig({ seats: { 'http://s1': refusingSeat({ [B]: '500000' }) } });
  const said = await r.exchange({ to: B, needMsat: 100000n, nodes: ['http://s1'] });
  assert.equal(said.ok, false);
  assert.deepEqual(r.log.map((x) => [x[0], x[1]]), [['send', '33'], ['receive', '33']]);
  assert.equal(r.kept().length, 0);
});

test('a seat that took the notes and failed to pay is asked again with the same notes at the next exchange', async () => {
  let calls = 0; const took = new Map();
  const seat = { holds: { [B]: '500000' }, post: async (b, { take, mint }) => {
    if (++calls === 1) { took.set(b.ecash, take(b.ecash)); return { status: 503, body: 'the payout failed; ask again' }; }
    const n = took.get(b.ecash) || take(b.ecash);
    return { status: 200, body: { ok: true, msat: String(n.msat), ecash: mint(b.to, n.msat) } };
  } };
  const r = exchangeRig({ seats: { 'http://s1': seat } });
  const r1 = await r.exchange({ to: B, needMsat: 100000n, nodes: ['http://s1'] });
  assert.equal(r1.ok, false);
  assert.equal(r.kept().length, 1, 'kept, not taken back');
  assert.ok(!r.log.some((x) => x[0] === 'receive' && x[1] === '33'), 'never received back while the seat may hold it');
  await r.exchange({ to: B, needMsat: 50000n, nodes: ['http://s1'] });
  assert.equal(r.bal.get(B), 150000n, 'the kept exchange was paid into B, and the new one');
  assert.equal(r.kept().length, 0);
});

function prepare({ parts, rows }) {
  const a = HTML.indexOf('    window.ARENA_PREPARE_FUNDS = async');
  const code = HTML.slice(a, HTML.indexOf('\n    };\n', a) + 7);
  const asked = [];
  const window = { sessionStorage: { getItem: () => 'seed' }, ARENA_WALLET_BALANCE: { parts }, ARENA_LOBBY_ROWS: rows, ARENA_BROWSER_STORE: () => ({}),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: 'LC' }), ARENA_ROW_NODES: () => ['http://s1'],
    ARENA_EXCHANGE_INTO: async (o) => { asked.push(o); return { ok: true, msat: String(o.needMsat), from: A, ms: 1 }; } };
  const ARENACLIENT = { toHex: (u) => Buffer.from(u).toString('hex'), tabSeed: () => 'seed', rememberedInvite: () => 'inv' };
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'crypto'], [code], '')(window, ARENACLIENT, { getRandomValues: (u) => u });
  return { window, asked };
}
const fixedRow = (id, fed, close) => ({ id, joinable: true, free: false, entryCloseMs: close, contract: { federationId: Uint8Array.from(Buffer.from(fed, 'hex')), stakeMsat: 100000n } });

test('the soonest round of a fixed stake is only in a federation without the money: the money is moved there before any press', async () => {
  const p = prepare({ parts: [{ federation: A, sats: 1000, merging: 0, arriving: 0 }], rows: [fixedRow('r1', B, 2000), fixedRow('r2', B, 3000)] });
  await p.window.ARENA_PREPARE_FUNDS();
  assert.equal(p.asked.length, 1);
  assert.equal(p.asked[0].to, B);
  assert.equal(p.asked[0].needMsat, 105000n, 'the stake and 5 %');
});

test('a federation of the soonest round already holds the stake: nothing is moved', async () => {
  const p = prepare({ parts: [{ federation: A, sats: 1000, merging: 0, arriving: 0 }, { federation: B, sats: 500, merging: 0, arriving: 0 }], rows: [fixedRow('r1', B, 2000)] });
  await p.window.ARENA_PREPARE_FUNDS();
  assert.equal(p.asked.length, 0);
});
