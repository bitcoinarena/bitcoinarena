// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO SEED PHRASE IN A REPORT, IN ANY SPELLING (kanban #1472, feedback #005 by Hexbox Tools 2026-11-11)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubKeys } from '../src/faucet.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('#1472 a 12-word seed is removed in lowercase, capitalised with commas, numbered on lines, in capitals; a sentence and 11 words stay', () => {
  for (const v of [W.join(' '), W.map((w) => w[0].toUpperCase() + w.slice(1)).join(', '), W.map((w, i) => `${i + 1}. ${w}`).join('\n'), W.join(' ').toUpperCase(), W.map((w, i) => `${i + 1}) ${w}`).join('; ')])
    assert.equal(scrubKeys(`my seed: ${v} - lost`), 'my seed: [removed] - lost', v);
  const sentence = 'The withdraw button did nothing when I clicked it twice after the round closed again today';
  assert.equal(scrubKeys(sentence), sentence);
  assert.equal(scrubKeys(W.slice(0, 11).join(' ')), W.slice(0, 11).join(' '));
  assert.equal(scrubKeys('key nsec1' + 'q'.repeat(58) + ' end'), 'key [removed] end');
});
