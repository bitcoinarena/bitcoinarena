// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA'S ROUNDS (kanban #715): the drawn rounds as rows with what the node does in each; none, and the reason in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoundsPanel } from '../dist/test/owner-rounds.mjs';

const T = Date.UTC(2026, 9, 27, 9, 30);
const show = (data) => renderToStaticMarkup(React.createElement(RoundsPanel, { initial: { loaded: true, data } }));

test('drawn rounds: one row each, the game and version, what the node does, coming / running / done', () => {
  const html = show({ why: null, upcoming: 1, rounds: [
    { round: 'a1', game: { name: 'btc-updown-15m', title: 'Bitcoin Up or Down', version: 24 }, startMs: T, endMs: T + 900000, phase: 'upcoming', does: ['Play and check', 'Pay out winners'], paid: true },
    { round: 'a2', game: { name: 'nextblock', title: 'Tick Tock, Next Block', version: 6 }, startMs: T - 3600000, endMs: T - 3000000, phase: 'done', does: ['Reserve (drawn, not seated)'], paid: false }] });
  assert.equal((html.match(/<tr class=/g) || []).length, 2);
  assert.match(html, /Bitcoin Up or Down v24/);
  assert.match(html, /Play and check · Pay out winners/);
  assert.match(html, /Tick Tock, Next Block v6 · free/);
  assert.match(html, /2026-10-27 09:30 UTC/);
  assert.match(html, /1 coming or running/);
  assert.doesNotMatch(html, /rounds-why/);
});

test('none: the reason, said plainly, and no empty table', () => {
  const html = show({ rounds: [], upcoming: 0, why: { kind: 'no game announced', says: 'Your node\'s announcement doesn\'t name the games today\'s rounds are for (Bitcoin Up or Down v24).' } });
  assert.match(html, /id="rounds-why"/);
  assert.match(html, /No rounds for this node right now/);
  assert.match(html, /Bitcoin Up or Down v24/);
  assert.doesNotMatch(html, /<table/);
});

test('the auditor\'s line shows rounds, objections and sats, and says when some are still being read (kanban #1002)', () => {
  const h = renderToStaticMarkup(React.createElement(RoundsPanel, { initial: { loaded: true, data: { rounds: [], why: null, audit: { audited: 3, objections: 1, earnedMsat: '12000', unread: 2 } } } }));
  assert.match(h, /As an auditor: 3 rounds audited, 1 objection filed, 12 sats earned so far \(2 still being read\)\./);
});

test('kanban #1282: a paid round shows its stake against the ceiling - both bounds and which binds; above it, refused or only shown on a test network', () => {
  const r = (ceiling) => ({ round: 'ab'.repeat(32), game: { name: 'nextblock', title: 'Tick Tock' }, startMs: Date.UTC(2026, 10, 9, 10), phase: 'upcoming', does: ['Play and check'], paid: true, ceiling });
  const income = { ok: true, stakeSats: '1000', ceilingSats: '8000', tableCeilingSats: '100000', incomeSeatSats: '8000', binds: 'income', enforced: true };
  let h = show({ rounds: [r(income)], upcoming: 1 });
  assert.ok(h.includes('stake 1,000 of a ceiling of 8,000 sat (census table 100,000 sat, one seat&#x27;s season income 8,000 sat; the income binds)'), h);
  h = show({ rounds: [r({ ...income, ok: false, stakeSats: '20000', enforced: false })], upcoming: 1 });
  assert.match(h, /class="sub ceiling warn"/);
  assert.match(h, /above it: shown only, not enforced on a test network/);
  h = show({ rounds: [r({ ok: true, stakeSats: '1000', ceilingSats: '100000', tableCeilingSats: '100000', incomeSeatSats: null, binds: 'table', enforced: true })], upcoming: 1 });
  assert.match(h, /stake 1,000 of a ceiling of 100,000 sat \(census table 100,000 sat; the table binds\)/);
  // a free round, or one with no ceiling read: no line
  assert.ok(!show({ rounds: [{ ...r(null), paid: false }], upcoming: 1 }).includes('ceiling'));
});
