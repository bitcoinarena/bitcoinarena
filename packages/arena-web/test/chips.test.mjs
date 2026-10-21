// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TILE'S CHIP LIST IN REACT (kanban #564): the blocks the page's ARENA_CHIP_LIST builds - notes, the role legend, a node's row with
// its role icons (on or not, each with its words) and its dashboard link, a round's row with the nodes assigned to it and its tag, a
// player's row - drawn as the page drew them; names are text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChipList, ROLE_KEYS } from '../dist/test/chips.mjs';

const icons = Object.fromEntries(ROLE_KEYS.map((k) => [k, `<svg data-k="${k}"></svg>`]));
const words = { verify: 'verify', settlement: 'settlement', custody: 'custody', liquidity: 'liquidity' };
const draw = (blocks) => renderToStaticMarkup(React.createElement(ChipList, { blocks, icons, words }));

test('notes, the legend, a node with its roles and dashboard link', () => {
  const h = draw([{ note: 'The nodes that answered for this game.' }, { legend: true },
    { row: { t: 'Node 1', s: '2fca1090', right: { href: 'https://tn4.example/guardian-1/dashboard', text: 'Dashboard ↗' },
      roles: [{ k: 'verify', on: true, title: 'verify' }, { k: 'settlement', on: true, title: 'settlement' }, { k: 'custody', on: true, title: 'custody: guardian of 337ae01a' }, { k: 'liquidity', on: false, title: 'not liquidity' }] } }]);
  assert.match(h, /^<div class="note">The nodes that answered for this game\.<\/div><div class="legend"><span><span class="ic"><svg data-k="verify"><\/svg><\/span>verify<\/span>/);
  assert.match(h, /<div class="row"><div class="main"><div class="t">Node 1<\/div><div class="s">2fca1090<\/div><\/div><span class="roles"><span class="role on" title="verify">/);
  assert.match(h, /<span class="role on" title="custody: guardian of 337ae01a">[\s\S]*<span class="role" title="not liquidity">/);
  assert.match(h, /<a href="https:\/\/tn4.example\/guardian-1\/dashboard" target="_blank" rel="noopener">Dashboard ↗<\/a><\/div>$/);
});

test('a round with its assigned nodes and its tag; a player named as text', () => {
  const h = draw([{ row: { t: 'Round 4d2c7420 · 1 min 39 s · 100 sat', s: '14:00:00 → 14:01:39 · 2 players', right: { text: 'running', live: true }, who: [{ k: 'verify', text: '1 3 7' }, { k: 'settlement', text: '2 4' }] } },
    { row: { t: '<img src=x>', s: 'round 4d2c7420 · player abcd0123', right: { text: 'chosen name' } } }]);
  assert.match(h, /<div class="who"><span title="verify"><span class="ic"><svg data-k="verify"><\/svg><\/span>1 3 7<\/span><span title="settlement">/);
  assert.match(h, /<span class="tag live">running<\/span>/);
  assert.match(h, /<div class="t">&lt;img src=x&gt;<\/div>/);
  assert.match(h, /<span class="tag">chosen name<\/span>/);
});
