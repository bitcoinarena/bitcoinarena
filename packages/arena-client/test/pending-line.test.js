// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PENDING LINE (WINDOW-10-SPEC, RULED 2026-10-01, §24): the page's own lookThePending, run on fake signer
// node answers - pending the moment a result is signed, the window's close in UTC, "provisional" while results still
// arrive, gone when the result becomes invalid, gone when the money is collected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pendingWindowLine, savedLockExpiration } from '../src/page-lock.js';
import { pageFunction } from './page-script.js';
import { ArenaText, ArenaBits } from './arena-text.js';   // the page's React lines (kanban #564)

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = html.indexOf('    async function lookThePending() {');
const src = html.slice(at, html.indexOf('\n    }\n', at) + 6);

function page({ answers, done = [] }) {
  const kept = new Map([['arena.pending.r1', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', nodes: ['http://a', 'http://b', 'http://c'] })]]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  const els = { 'arena-bal-pending-when': { textContent: '' }, 'arena-lobby-pending': { parentNode: { title: '' } } };
  const window = { ArenaText, ArenaBits, ARENA_WALLET_BALANCE: { sats: 10, pending: 0 } };
  const fetch = async (u) => { const a = answers[new URL(u).host]; return a ? { ok: true, json: async () => a } : { ok: false }; };
  // the page's own line functions (3f1e2674 had the page call them; this stub lacked them since)
  const ARENACLIENT = { savedCollects: () => done.map((r) => ({ roundIdHex: r, done: { payout: 'x' } })), pendingWindowLine, savedLockExpiration };
  const run = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'ARENACLIENT', 'fetch', 'document', 'window', 'paintMoney'], src, '; return lookThePending();');
  return { go: () => run(() => store, ARENACLIENT, fetch, { getElementById: (id) => els[id] || null }, window, () => {}), window, els, kept };
}
// THE WINDOW STILL OPEN (a close in the future); `closed` is one already past
const signed = (msat, more = {}) => ({ kind: 'payout', pendingMsat: msat, windowCloseMs: String(Date.UTC(2099, 9, 1, 12, 11, 22)), provisional: false, ...more });

test('signed: the majority figure is pending at once, with the window close in UTC', async () => {
  const p = page({ answers: { a: signed('196000'), b: signed('196000'), c: signed('98000') } });
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 196, 'the pending is not the majority figure');
  assert.equal(p.window.ARENA_WALLET_BALANCE.pending, 196);
  assert.equal(p.els['arena-bal-pending-when'].textContent, 'window closes 12:11:22 UTC');
});

test('past the close the line says the window closed and the payout is on its way (playtest d917975d)', async () => {
  const closeMs = Math.floor((Date.now() - 60000) / 1000) * 1000;   // a minute ago: within the 10 min the payout is on its way
  const closed = signed('192000', { windowCloseMs: String(closeMs) });
  const p = page({ answers: { a: closed, b: closed } });
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 192);
  assert.equal(p.els['arena-bal-pending-when'].textContent, `window closed ${new Date(closeMs).toISOString().slice(11, 19)} UTC \u00b7 paying out`);
  // AND NOT "PAYING OUT" FOREVER (MF 18, 3f1e2674): long past the close it is "not paid yet"
  const old = signed('192000', { windowCloseMs: String(Date.UTC(2026, 9, 3, 6, 43, 21)) });
  const q = page({ answers: { a: old, b: old } });
  await q.go();
  assert.match(q.els['arena-bal-pending-when'].textContent, /^window closed 06:43:21 UTC \u00b7 not paid yet/);
});

test('while other results still arrive the figure is marked provisional', async () => {
  const p = page({ answers: { a: signed('98000', { provisional: true }), b: signed('98000', { provisional: true }) } });
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 98);
  assert.match(p.els['arena-bal-pending-when'].textContent, /provisional/);
});

test('a result that becomes invalid takes the line away: no figure, or 0, is no pending', async () => {
  for (const answers of [{ a: { pendingMsat: null, state: 'SUSPENDED' }, b: { pendingMsat: null } }, { a: signed('0'), b: signed('0') }, {}]) {
    const p = page({ answers });
    await p.go();
    assert.equal(p.window.ARENA_PENDING_SATS, 0, `a pending stayed: ${JSON.stringify(answers)}`);
    assert.equal(p.els['arena-bal-pending-when'].textContent, '');
  }
});

test('collected into the wallet: the round\'s note goes and nothing is pending', async () => {
  const p = page({ answers: { a: signed('196000'), b: signed('196000') }, done: ['r1'] });
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 0);
  assert.equal(p.kept.size, 0, 'the collected round is still asked about');
});

// SETTLED WITHOUT FINAL (2026-10-01): the signer nodes answer a round settled and accepted, with no FINAL signature,
// with state PROVISIONALLY_FINAL, no pending amount, and the accepted settlement as the reason - the page shows no line,
// as for an invalid payment; and the same note on a live round with its amount shows it again.
test('a round the nodes report settled - PROVISIONALLY_FINAL, no pending amount - gives no line; the live amount does', async () => {
  const settled = { state: 'PROVISIONALLY_FINAL', pendingMsat: null, kind: null, settled: 'ab'.repeat(32),
    windowCloseMs: String(Date.UTC(2026, 8, 30, 22, 13, 30)), why: `the round's settlement ${'ab'.repeat(32)} is ACCEPTED by the federation and pays this entry's share: nothing is pending` };
  const p = page({ answers: { a: settled, b: settled, c: settled } });
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 0, 'a settled round left a pending amount');
  assert.equal(p.window.ARENA_WALLET_BALANCE.pending, 0);
  assert.equal(p.els['arena-bal-pending-when'].textContent, '', 'a settled round left its window line');
  const live = page({ answers: { a: signed('196000', { state: 'PROVISIONALLY_FINAL' }), b: signed('196000', { state: 'PROVISIONALLY_FINAL' }), c: settled } });
  await live.go();
  assert.equal(live.window.ARENA_PENDING_SATS, 196);
});

// TWO PLAYERS IN ONE BROWSER (ORDER-2116, measured 2026-10-02 01:56Z): the notes share one store; keyed by round alone the
// loser's overwrote the winner's and the winner's tab showed nothing while every node said 192000 msat. One note per
// entry, and a tab asks only about the notes it wrote; a tab that wrote none (a reopened browser) asks about all.
test('two entries of one round in one browser: each tab asks only about its own entry', async () => {
  const kept = new Map([
    ['arena.pending.r1.e1', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', nodes: ['http://a'] })],
    ['arena.pending.r1.e2', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e2', nodes: ['http://a'] })],
  ]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  const asked = [];
  const fetch = async (u) => { const e = new URL(u).searchParams.get('entry'); asked.push(e); return { ok: true, json: async () => signed(e === 'e1' ? '192000' : '0') }; };
  const tab = (mine) => {
    const session = new Map(mine ? [['arena.pending.mine', JSON.stringify(mine)]] : []);
    const window = { ArenaText, ArenaBits, ARENA_WALLET_BALANCE: { sats: 0, pending: 0 }, sessionStorage: { getItem: (k) => session.get(k) ?? null } };
    const run = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'ARENACLIENT', 'fetch', 'document', 'window', 'paintMoney'], src, '; return lookThePending();');
    return run(() => store, { savedCollects: () => [], pendingWindowLine, savedLockExpiration }, fetch, { getElementById: () => null }, window, () => {}).then(() => window.ARENA_PENDING_SATS);
  };
  const winner = await tab(['arena.pending.r1.e1']);
  const winnerAsked = asked.splice(0);
  const loser = await tab(['arena.pending.r1.e2']);
  const loserAsked = asked.splice(0);
  const reopened = await tab(null);
  console.log('  FACTS (two tabs):', JSON.stringify({ winner, winnerAsked, loser, loserAsked, reopened, reopenedAsked: asked }));
  assert.equal(winner, 192, 'the winner\'s tab does not show its own pending');
  assert.deepEqual(winnerAsked, ['e1']);
  assert.equal(loser, 0);
  assert.deepEqual(loserAsked, ['e2']);
  assert.deepEqual([...asked].sort(), ['e1', 'e2'], 'a tab with no notes of its own does not ask about every note');
});

// WINDOW-LIVE-1155 (2026-10-02: "If the payment becomes invalid, the pending line disappears"): measured on testnet4,
// four seats voided the run (each offering the 96 sat stake back as a refund) while three still said PROVISIONALLY_FINAL
// 192 sat - and the line showed 96, then would have shown 192. A refund is not winnings, and a figure fewer than half the
// answering seats say is not shown.
test('four seats VOID with a refund, three still PROVISIONALLY_FINAL with winnings: no line', async () => {
  const voided = { state: 'VOID', kind: 'refund', pendingMsat: '96000', windowCloseMs: String(Date.UTC(2026, 9, 1, 12, 11, 22)) };
  const answers = { a: voided, b: voided, c: voided, d: voided, e: signed('192000'), f: signed('192000'), g: signed('192000') };
  const p = page({ answers });
  const note = JSON.parse(p.kept.get('arena.pending.r1')); note.nodes = Object.keys(answers).map((h) => 'http://' + h);
  p.kept.set('arena.pending.r1', JSON.stringify(note));
  await p.go();
  assert.equal(p.window.ARENA_PENDING_SATS, 0, 'a refund or a minority figure was shown as pending winnings');
  assert.equal(p.els['arena-bal-pending-when'].textContent, '');
});

// ONE LOOK AT A TIME, AND A SETTLED ROUND LESS OFTEN (2026-10-16: "Lower the amount of concurrent connections and network
// load"; measured on live UI 154: GET /standing 266 times in 60 s of one run)
test('a settled answer is asked again only after 30 s, a provisional one at every look, and looks never overlap', async () => {
  const kept = new Map([['arena.pending.r1.e1', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', nodes: ['http://a', 'http://b'] })]]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  const run = (provisional) => {
    const counted = { asked: 0 };
    const fetch = async () => { counted.asked++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => signed('192000', { provisional }) }; };
    const window = { ArenaText, ArenaBits, ARENA_WALLET_BALANCE: { sats: 0, pending: 0 }, sessionStorage: { getItem: () => null } };
    const look = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'ARENACLIENT', 'fetch', 'document', 'window', 'paintMoney'], src, '; return lookThePending;')(
      () => store, { savedCollects: () => [], pendingWindowLine, savedLockExpiration }, fetch, { getElementById: () => null }, window, () => {});
    return { look, counted, window };
  };
  const settled = run(false);
  await Promise.all([settled.look(), settled.look()]);                  // two looks at once: the second does nothing
  assert.equal(settled.counted.asked, 2, 'one look, both signer nodes asked once');
  await settled.look(); await settled.look();
  assert.equal(settled.counted.asked, 2, 'a settled answer is not asked again within 30 s');
  assert.equal(settled.window.ARENA_PENDING_SATS, 192, 'its last answer still counts');
  const moving = run(true);
  await moving.look(); await moving.look(); await moving.look();
  assert.equal(moving.counted.asked, 6, 'a provisional answer is asked at every look');
});

test('a round no signer node answers for is asked again after 10 s, not at every look', async () => {
  const kept = new Map([['arena.pending.r9.e9', JSON.stringify({ roundIdHex: 'r9', entryIdHex: 'e9', nodes: ['http://a', 'http://b', 'http://c'] })]]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  let asked = 0;
  const fetch = async () => { asked++; return { ok: false, status: 404, json: async () => null }; };
  const window = { ArenaText, ArenaBits, ARENA_WALLET_BALANCE: { sats: 0, pending: 0 }, sessionStorage: { getItem: () => null } };
  const look = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'ARENACLIENT', 'fetch', 'document', 'window', 'paintMoney'], src, '; return lookThePending;')(
    () => store, { savedCollects: () => [], pendingWindowLine, savedLockExpiration }, fetch, { getElementById: () => null }, window, () => {});
  for (let k = 0; k < 5; k++) await look();
  assert.equal(asked, 3, 'asked once (three signer nodes), not five times');
  assert.equal(window.ARENA_PENDING_SATS, 0);
  look.st.seen.get('arena.pending.r9.e9').at -= 10001;              // ten seconds on
  await look();
  assert.equal(asked, 6, 'asked again after 10 s');
  look.st.seen.get('arena.pending.r9.e9').at -= 10001;              // ten seconds more: the second miss waits 20 s
  await look();
  assert.equal(asked, 6, 'not after 10 s once it went unanswered twice');
  look.st.seen.get('arena.pending.r9.e9').at -= 10001;
  await look();
  assert.equal(asked, 9, 'after 20 s');
});
