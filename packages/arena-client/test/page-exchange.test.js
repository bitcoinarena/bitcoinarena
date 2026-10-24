// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S E-CASH EXCHANGE (kanban #614): its own ARENA_EXCHANGE_INTO (index.html) hands the missing amount of the wallet's e-cash of
// another federation to a seat and receives the seat's e-cash of the round's federation - no Lightning, no dialog; a seat's refusal gives
// the notes back to the wallet; a seat that did not answer is asked again, with the same notes, at the next exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const A = '33'.repeat(32), B = '4d'.repeat(32);

function page({ seats }) {
  const store = new Map();
  const vault = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const keys = () => [...store.keys()];
  const log = [];
  const wallet = (fed) => ({
    sendEcash: async (m) => { log.push(['send', fed, m]); return JSON.stringify({ msat: Number(m), ecash: `notes-${fed.slice(0, 2)}-${m}` }); },
    receiveEcash: async (e) => { log.push(['receive', fed, e]); return JSON.stringify({ state: 'Success' }); },
  });
  const window = { ARENA_BROWSER_STORE: () => new Proxy(vault, { ownKeys: () => keys(), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }),
    ARENA_WALLET_BALANCE: { parts: [{ federation: A, sats: 1000, merging: 0, arriving: 0 }] }, ARENA_WALLETS: new Map([[A, wallet(A)], [B, wallet(B)]]) };
  const fetch = async (url, o) => {
    const seat = seats[new URL(url).origin];
    const said = await seat(JSON.parse(o.body));
    return { ok: said.status === 200, status: said.status, json: async () => said.body, text: async () => String(said.body) };
  };
  const a = HTML.indexOf('    window.ARENA_EXCHANGE_INTO = async');
  const code = HTML.slice(a, HTML.indexOf('\n    };\n', a) + 7);
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'fetch', 'AbortSignal'], [code], '')(window, { fromHex: (h) => Buffer.from(h, 'hex') }, fetch, { timeout: () => undefined });
  return { window, log, keys };
}

test('the round\'s federation lacks it: the other federation\'s e-cash to a seat, the seat\'s e-cash of the round\'s back', async () => {
  const seen = [];
  const p = page({ seats: {
    'http://s1': async () => ({ status: 409, body: 'this seat holds 0 sat in federation 4d4d4d4d: too little' }),
    'http://s2': async (b) => { seen.push(b); return { status: 200, body: { ok: true, msat: b.amountMsat, ecash: 'notes-from-seat', federation: B } }; } } });
  const r = await p.window.ARENA_EXCHANGE_INTO({ to: B, toInvite: 'inv', needMsat: 100000n, nodes: ['http://s1', 'http://s2'], seed: null, LockClient: null });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.from, A);
  assert.deepEqual(seen.map((b) => [b.from, b.to, b.amountMsat]), [[A, B, '100000']]);
  assert.deepEqual(p.log, [['send', A, '100000'], ['receive', B, 'notes-from-seat']]);
  assert.equal(p.keys().filter((k) => k.startsWith('arena.ecash.exchange.')).length, 0, 'nothing kept once received');
});

test('every seat refuses outright: the notes come back to the wallet they left', async () => {
  const p = page({ seats: { 'http://s1': async () => ({ status: 409, body: 'too little' }) } });
  const r = await p.window.ARENA_EXCHANGE_INTO({ to: B, toInvite: 'inv', needMsat: 100000n, nodes: ['http://s1'], seed: null, LockClient: null });
  assert.equal(r.ok, false);
  assert.deepEqual(p.log.map((x) => [x[0], x[1]]), [['send', A], ['receive', A]]);
});

test('a seat that took the notes and failed to pay is asked again with the same notes at the next exchange', async () => {
  let calls = 0;
  const p = page({ seats: { 'http://s1': async (b) => (++calls === 1 ? { status: 503, body: 'the payout failed; ask again' } : { status: 200, body: { ok: true, msat: b.amountMsat, ecash: `paid-${b.ecash}` } }) } });
  const r1 = await p.window.ARENA_EXCHANGE_INTO({ to: B, toInvite: 'inv', needMsat: 100000n, nodes: ['http://s1'], seed: null, LockClient: null });
  assert.equal(r1.ok, false);
  assert.equal(p.keys().filter((k) => k.startsWith('arena.ecash.exchange.')).length, 1, 'kept, not taken back');
  assert.ok(!p.log.some((x) => x[0] === 'receive' && x[1] === A), 'never received back while a seat may hold it');
  await p.window.ARENA_EXCHANGE_INTO({ to: B, toInvite: 'inv', needMsat: 50000n, nodes: ['http://s1'], seed: null, LockClient: null });
  assert.ok(p.log.some((x) => x[0] === 'receive' && x[1] === B && x[2] === 'paid-notes-33-100000'), 'the kept exchange was paid into B');
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
