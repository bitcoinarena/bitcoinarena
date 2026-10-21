// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON BOARD'S ROWS IN REACT (kanban #564): as the page's seasonBoard drew them - rank, name, badges from the page's book (an
// image by its route, else the glyph), "you" for the viewer and a Zap for another player, rounds / wins / best, net up or down, a gap
// mark where ranks skip, each row's data-player for the page's observer - and a tapped badge's words, hidden by a second tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeasonRows } from '../dist/test/season.mjs';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ROWS = [
  { rank: 1, player: key(0x11), name: 'satoshi', rounds: 6, wins: 4, best: '8,304,450', net: '+29.4 sat', netMsat: '29400', sign: 1 },
  { rank: 2, player: key(0xb2), name: 'brave-otter-0042', rounds: 1, wins: 0, best: '120,000', net: '+3 sat', netMsat: '3000', sign: 1, mine: true },
  { rank: 5, player: key(0x22), name: 'hal', rounds: 2, wins: 0, best: '0', net: '-2 sat', netMsat: '-2000', sign: -1 },
];
const BOOK = { [key(0x11)]: { badges: [{ title: 'First win', glyph: { mark: 'W', colour: '#f7931a' } }, { title: 'Streak', image: '/badge/streak.svg', glyph: { mark: 'S', colour: '#3fb950' } }] } };

test('the rows: rank, name, badges, you or Zap, the counts, the net, a gap where ranks skip', () => {
  const h = renderToStaticMarkup(React.createElement(SeasonRows, { rows: ROWS, badgesOf: (p) => BOOK[p] || null, via: (u) => 'https://seat.example' + u, onZap: () => {} }));
  assert.match(h, /<li class="row" data-player="1111[0-9a-f]*"><span class="rank">1<\/span>/);
  assert.match(h, /<span class="nm">satoshi<\/span><span class="bdg"><button type="button" class="bi g" title="First win" aria-label="First win" data-mark="W" style="--bc:#f7931a"><\/button><button type="button" class="bi" title="Streak" aria-label="Streak"><img alt="" width="18" height="18" src="https:\/\/seat.example\/badge\/streak.svg"\/><\/button><\/span><button type="button" class="zap" title="Zap satoshi">⚡ Zap<\/button>/);
  assert.match(h, /<div class="s">6 rounds · 4 wins · best 8,304,450<\/div>/);
  assert.match(h, /<li class="row mine" data-player="b2b2[0-9a-f]*">[\s\S]*<span class="you">you<\/span>/);
  assert.match(h, /<div class="s">1 round · 0 wins · best 120,000<\/div>/);
  assert.match(h, /<li class="row gap" data-player="2222[0-9a-f]*">[\s\S]*<b class="net down" title="-2000 msat">-2 sat<\/b>/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(SeasonRows, { rows: ROWS })), /class="zap"/, 'no zap without the zap box');
});

test('a tapped badge says its words under the row; the same badge again hides them', () => {
  const t = new SeasonRows({ rows: ROWS, badgesOf: (p) => BOOK[p] || null });
  t.setState = (u) => Object.assign(t.state, typeof u === 'function' ? u(t.state) : u);
  t.say(key(0x11), 'First win');
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, t.render())), /<div class="bt">First win<\/div>/);
  t.say(key(0x11), 'First win');
  assert.equal(t.state.said[key(0x11)], '');
});
