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
