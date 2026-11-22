// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DUPLICATE POSTING IS DECIDED BEFORE ITS DAY BEGINS (kanban #742, measured 2026-10-29 ~23:10Z: second-host seat 1 still held three 10-30 emergency
// postings of 158103 an hour before the day - under load its chain view was still being read, taken for "no posting", asked again only after
// 10 min). dup-ask.js: the day starting soonest first, a view still being read again in 15 s, a day within 6 h every minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextToAsk, askAgainAt, DUP_SOON_ASK_MS, DUP_PENDING_ASK_MS } from '../src/dup-ask.js';

const H = 3600000, ASK = 600000;
const now = Date.UTC(2026, 9, 29, 23, 0);
const day30 = Date.UTC(2026, 9, 30), day31 = Date.UTC(2026, 9, 31);

test('a series never asked is due at once, and the day starting soonest goes first', () => {
  const rows = [{ k: 'b', startMs: day31 }, { k: 'a', startMs: day30 }, { k: 'c', startMs: day30 + 2 * H }];
  assert.equal(nextToAsk(rows, { asked: new Map(), now, askMs: ASK }).k, 'a');
  assert.equal(nextToAsk([], { asked: new Map(), now, askMs: ASK }), null);
});

test('a chain view still being read is asked again in 15 s, not after 10 min', () => {
  const asked = new Map([['a', { at: now - 5000, pending: true }]]);
  assert.equal(nextToAsk([{ k: 'a', startMs: day31 }], { asked, now, askMs: ASK }), null, 'not yet after 5 s');
  assert.equal(nextToAsk([{ k: 'a', startMs: day31 }], { asked, now: now - 5000 + DUP_PENDING_ASK_MS, askMs: ASK }).k, 'a', 'due after 15 s');
});

test('not found: a day within 6 h is asked again every minute, a later one after the long wait', () => {
  const asked = new Map([['soon', { at: now, pending: false }], ['late', { at: now, pending: false }]]);
  const rows = [{ k: 'soon', startMs: day30 }, { k: 'late', startMs: day31 }];
  assert.equal(nextToAsk(rows, { asked, now: now + DUP_SOON_ASK_MS - 1, askMs: ASK }), null);
  assert.equal(nextToAsk(rows, { asked, now: now + DUP_SOON_ASK_MS, askMs: ASK }).k, 'soon', '10-30 (1 h away) again after a minute');
  assert.equal(askAgainAt({ at: now, pending: false, startMs: day31, now, askMs: ASK }), now + ASK, '10-31 (25 h away) after 10 min');
});

// KANBAN #3380 (2026-11-23): the earliest emergency posting of Next Block's 11-23 named config 00..00, which no seat runs - held as the day's
// lead, it would have dropped the valid emergency grid posted after it
test('#3380 a posting this seat refuses does not take the lead: the valid later emergency grid is kept', async () => {
  const { dayPostingsKept } = await import('../src/dup-ask.js');
  const rows = [{ txid: 'aa', role: 'emergency', height: 162830, refused: true }, { txid: 'bb', role: 'emergency', height: 162900 },
    { txid: 'cc', role: 'primary', height: 162671, refused: true }, { txid: 'dd', role: 'backup', height: 162688, refused: true }];
  const k = dayPostingsKept(rows);
  assert.equal(k.lead.txid, 'bb');
  assert.deepEqual([...k.keep], ['bb']);
  // nothing refused: the earliest emergency leads, as before
  const before = dayPostingsKept(rows.map((r) => ({ ...r, refused: false })));
  assert.equal(before.lead.txid, 'aa');
  assert.deepEqual([...before.keep].sort(), ['aa', 'dd']);
});
