// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3912 (measured 2026-11-28 12:13Z through the tn4 tunnel): one Windows Chrome held 12 pending notes of one entry (a market order with no
// fill, every seat answering the same "refund") and asked all 14 seats GET /standing for each note every 30 s, for hours; and it re-read GET /seating
// of the same round from every seat once a second. Notes of one entry share one ask per look, an unchanged answer backs off, a note stops being asked
// 6 h past its window's close. (2.0: the seating half of the 1.9 fix needs the #1449 seating keep, which 2.0 does not have.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pendingWindowLine, savedLockExpiration } from '../src/page-lock.js';
import { pageFunction } from './page-script.js';
import { ArenaText, ArenaBits } from './arena-text.js';

const URL_ = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(URL_, 'utf8');
const at = html.indexOf('    async function lookThePending() {');
const src = html.slice(at, html.indexOf('\n    }\n', at) + 6);
const NODES = Array.from({ length: 14 }, (_, i) => `http://s${i + 1}`);

function page(notes, answer) {
  const kept = new Map(notes);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k), setItem: (k, v) => kept.set(k, v) };
  const counted = { asked: 0 };
  const fetch = async () => { counted.asked++; return { ok: true, json: async () => answer() }; };
  const window = { ArenaText, ArenaBits, ARENA_WALLET_BALANCE: { sats: 0, pending: 0 }, sessionStorage: { getItem: () => null } };
  const look = pageFunction(URL_, ['vault', 'ARENACLIENT', 'fetch', 'document', 'window', 'paintMoney'], src, '; return lookThePending;')(
    () => store, { savedCollects: () => [], pendingWindowLine, savedLockExpiration }, fetch, { getElementById: () => null }, window, () => {});
  return { look, counted };
}
const refund = (closeMs) => ({ kind: 'refund', state: 'ATTESTED', outcome: 0, provisional: false, pendingMsat: null, windowCloseMs: String(closeMs) });
const age = (look, ms) => { for (const v of look.st.seen.values()) v.at -= ms; };

test('#3912 twelve notes of one entry: each look asks the 14 seats once, not twelve times', async () => {
  const notes = Array.from({ length: 12 }, (_, i) => [`arena.pending.r1.o${i}`, JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', order: i, nodes: NODES })]);
  const p = page(notes, () => refund(Date.now() - 600000));
  await p.look();
  assert.equal(p.counted.asked, 14, 'one ask of 14 seats for the entry, not 12 x 14');
  age(p.look, 30001); await p.look();
  assert.equal(p.counted.asked, 28, 'after 30 s the entry is asked again, once');
});

test('#3912 an answer the seats repeat unchanged is asked half as often each time, at most every 10 min', async () => {
  const p = page([['arena.pending.r2.e2', JSON.stringify({ roundIdHex: 'r2', entryIdHex: 'e2', nodes: NODES })]], () => refund(Date.now() - 600000));
  await p.look();                                   // 14
  age(p.look, 30001); await p.look();               // 28: the first repeat
  age(p.look, 30001); await p.look();
  assert.equal(p.counted.asked, 28, 'unchanged once: waits 60 s, not 30 s');
  age(p.look, 30001); await p.look();
  assert.equal(p.counted.asked, 42, 'after 60 s');
  for (let i = 0; i < 20; i++) { age(p.look, 600001); await p.look(); }
  const before = p.counted.asked; age(p.look, 599000); await p.look();
  assert.equal(p.counted.asked, before, 'never more often than every 10 min');
});

test('#3912 6 h past the window close a note is not asked again in this tab', async () => {
  const p = page([['arena.pending.r3.e3', JSON.stringify({ roundIdHex: 'r3', entryIdHex: 'e3', nodes: NODES })]], () => refund(Date.now() - 7 * 3600000));
  await p.look();
  assert.equal(p.counted.asked, 14);
  for (let i = 0; i < 5; i++) { age(p.look, 3600000); await p.look(); }
  assert.equal(p.counted.asked, 14, 'a stuck note stops');
});

test('#3912 a provisional answer past its window close backs off too', async () => {
  const p = page([['arena.pending.r4.e4', JSON.stringify({ roundIdHex: 'r4', entryIdHex: 'e4', nodes: NODES })]],
    () => ({ kind: 'payout', pendingMsat: null, state: 'PROVISIONALLY_FINAL', provisional: true, windowCloseMs: String(Date.now() - 60000) }));
  await p.look(); await p.look(); await p.look();
  assert.equal(p.counted.asked, 14, 'closed window: not asked at every look');
});
