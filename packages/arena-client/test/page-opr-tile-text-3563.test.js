// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORANGE PILL RUN TILE SAYS WHAT THE GAME PAYS (kanban #3563, feedback #409): the round is free and the best player wins 2,500 real
// sats (packages/orange-pill-run/client/src/rules.js) - the tile said "the best three share the pot".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const RULES = readFileSync(new URL('../../orange-pill-run/client/src/rules.js', import.meta.url), 'utf8');

test('the Orange Pill Run tile names the free round and the 2,500 sat prize to the best player, as the rules do', () => {
  const at = PAGE.indexOf('<div class="name">Orange Pill Run</div>');
  assert.ok(at > 0, 'the page draws no Orange Pill Run tile');
  const desc = PAGE.slice(PAGE.indexOf('<div class="desc">', at), PAGE.indexOf('</div>', PAGE.indexOf('<div class="desc">', at)));
  assert.doesNotMatch(desc, /share the pot|best three/i);
  assert.match(desc, /free/i);
  assert.match(desc, /best player/i);
  assert.match(desc, /2,500/);
  assert.match(RULES, /best player[^"]*wins 2,500 real sats/);
});
