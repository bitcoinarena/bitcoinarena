// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 27 skeptic 2 (#1641 / #2148) - FAILS on bf19b45d5: A TAB OPENED ON THE FREE PHRASE WHILE ANOTHER TAB'S RESUME HOLDS
// ITS LOCK DROPS THE PHRASE AND MINTS A NEW ONE.
//
// Since #2148 resumeEcashExchanges takes another phrase's lock (arena.phrase.<P1>) and holds it across the seat's POST /exchange (up to
// timeoutMs, 30 s on the page) and two cold wallet opens. The collect writes arena.seed.collecting.<16> while it holds such a lock, so the seed
// keeper of a tab that picks that phrase WAITS for it ((b), 2026-10-07: "the seed keeper must not mint"). The resume writes no such mark: the
// player opens a second tab (or reloads the one that played P1) while tab B (P2) resumes P1's record - the new tab picks the free kept phrase
// P1, finds its lock taken with no collecting mark, takes it for a live tab, drops P1 and reloads (then mints: P2 is held, P1 beat 0 s ago).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const from = html.indexOf('function arenaSeedKeeper(');
const to = html.indexOf('\n    try {\n      window.ARENA_SEED_KEEPER', from);
const Keeper = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), [], html.slice(from, to), '; return arenaSeedKeeper;')();

const FROM = 'aa'.repeat(32), TOF = 'bb'.repeat(32);
const P1 = '9999aaaa0000bbbb' + 'c'.repeat(48), P2 = '1212dddd3434eeee' + 'f'.repeat(48);
function shared() { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; }
const wallet = (name) => { const w = { name, received: [], sent: 0 };
  w.sendEcash = async (msat) => { w.sent += Number(msat); return JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}` }); };
  w.receiveEcash = async (e) => { w.received.push(e); return JSON.stringify({ state: 'Success', msat: 50000 }); };
  return w; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a tab opened on the free phrase while a resume holds its lock keeps that phrase (waits), never drops it to mint', async () => {
  const L = shared();
  L.setItem('arena.seeds', JSON.stringify([{ hex: P1, from: 'minted', at: 1 }, { hex: P2, from: 'minted', at: 2 }]));
  // P1's tab handed 50 sat to a seat that answered late, then closed (no heartbeat, its lock free)
  let seatAnswers = false, seatAsked, seatLets;
  const asked = new Promise((r) => { seatAsked = r; }); const lets = new Promise((r) => { seatLets = r; });
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TOF]: '10000000' }, maxMsat: '10000000' }), { status: 200 });
    if (!seatAnswers) throw new Error('The operation was aborted due to timeout');
    seatAsked(); await lets;   // the seat takes its time (the page gives it 30 s)
    return new Response(JSON.stringify({ ecash: 'fedimint-seat-answer', msat: '50000' }), { status: 200 });
  };
  const A = { [FROM]: wallet('P1-from'), [TOF]: wallet('P1-to') };
  const t0 = Date.now();
  await exchangeEcashInto({ storage: L, from: FROM, to: TOF, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM], walletTo: async () => A[TOF], fetcher, nowMs: t0, timeoutMs: 30, phrase16: P1 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  assert.equal(readEcashTransfer(L, key).state, 'handed');
  seatAnswers = true;
  // TAB B plays P2 (a live tab: its heartbeat and its lock)
  L.setItem('arena.seed.held.' + P2.slice(0, 16), JSON.stringify({ tab: 'tabB', at: Date.now() }));
  let releaseB; const bHeld = new Promise((r) => { releaseB = r; });
  let bGot; const bGotIt = new Promise((r) => { bGot = r; });
  const holderB = navigator.locks.request('arena.phrase.' + P2.slice(0, 16), async () => { bGot(); await bHeld; });
  await bGotIt;
  const ownP1 = { [FROM]: wallet('P1own-from'), [TOF]: wallet('P1own-to') };
  const B = { [FROM]: wallet('P2-from'), [TOF]: wallet('P2-to') };
  // tab B asks for an exchange: P1's record is resumed under P1's lock
  const resuming = resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => B[fid], fetcher, seats: [], nowMs: t0 + 60000,
    phrase16: P2.slice(0, 16), takeUnnamed: false, walletForPhrase: async (h16, fid) => ownP1[fid], leavePhrase: () => {} });
  await asked;   // the resume holds arena.phrase.<P1> now, waiting for the seat
  // THE PLAYER OPENS A NEW TAB (or reloads P1's): its seed keeper picks the one free kept phrase, P1
  const T = shared(); let reloads = 0;
  Keeper({ L, T, now: () => Date.now(), every: () => {}, on: () => {}, random: () => 'tabC', locks: navigator.locks, reload: () => { reloads++; } });
  // (the keeper's first beat marks the phrase it picked: arena.seed.held.<16> by this tab - read here, since a drop may already have cleared T)
  const picked = (JSON.parse(L.getItem('arena.seed.held.' + P1.slice(0, 16)) || 'null') || {}).tab === 'tabC' ? P1 : T.getItem('arena.player.seed');
  await wait(50);
  const facts = { picked: picked && picked.slice(0, 8), seedAfter: (T.getItem('arena.player.seed') || '').slice(0, 8) || null, reloads };
  seatLets(); const rows = await resuming; releaseB(); await holderB;
  console.log('  FACTS a44-refute-27-s2-1:', JSON.stringify({ ...facts, rows }));
  assert.equal(picked, P1, 'precondition: the new tab picks the free kept phrase P1');
  assert.equal(T.getItem('arena.player.seed'), P1,
    `the new tab dropped P1 (its lock held by tab B's exchange resume, with no collecting mark) and reloads to mint a new phrase: ${JSON.stringify(facts)}`);
  assert.equal(reloads, 0);
});
