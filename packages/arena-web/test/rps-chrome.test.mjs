// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS VERSION 5 AROUND ITS TABLE, IN REACT (kanban #564): the header's chip hidden until a round is drawn and with none,
// FREE / PAID by the round; a refused tap's line; the big verdict; the demo's "n / 9" line; the line outside the Arena page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KindChip, Overlays, NotInArena } from '../dist/test/rps-chrome.mjs';

const r = (c, p) => renderToStaticMarkup(React.createElement(c, p));

test('the chip: hidden before a round is drawn and with none; FREE or PAID by the round', () => {
  assert.equal(r(KindChip, {}), '<span class="chip" id="kind" hidden=""></span>');
  assert.equal(r(KindChip, { phase: 'none', free: true }), '<span class="chip free" id="kind" hidden="">FREE</span>');
  assert.equal(r(KindChip, { phase: 'pick', free: true }), '<span class="chip free" id="kind">FREE</span>');
  assert.equal(r(KindChip, { phase: 'wait', free: false }), '<span class="chip paid" id="kind">PAID</span>');
});

test('over the page: the demo\'s line, a refused tap\'s line, the verdict; nothing when there is nothing', () => {
  assert.equal(r(Overlays, {}), '');
  assert.equal(r(Overlays, { demo: { n: 4, a: 1, b: 2 } }), '<div class="demo-label"><b>5 / 9</b> You ✋ Paper <i>vs</i> Scissors ✌️ them</div>');
  assert.equal(r(Overlays, { toasts: [{ id: 1, text: 'That tap did not go in (refused) - tap again' }] }), '<div class="demo-label">That tap did not go in (refused) - tap again</div>');
  assert.equal(r(Overlays, { verdict: { id: 2, kind: 'win', word: 'WON' } }), '<div class="verdict-big win"><b>WON</b></div>');
});

test('outside the Arena page', () => {
  assert.equal(r(NotInArena, {}), '<div class="none"><span class="big">✊✋✌️</span>This client runs inside the Bitcoin Arena page, which hands it the game.</div>');
});
