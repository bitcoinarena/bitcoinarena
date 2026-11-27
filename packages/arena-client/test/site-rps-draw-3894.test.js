// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SITE SAYS WHAT A ROCK PAPER SCISSORS DRAW PAYS (kanban #3894, Feedback #600): the game pays 90 of a 100 sat stake back on a draw
// (10 sat fees) and the winner 180 of 200; the home card and the docs said "a draw returns both stakes" / "A draw returns them".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

test('the home card and the docs name the 10 % fees on a Rock Paper Scissors win and draw', () => {
  for (const p of ['src/website/www/index.html', 'src/website/www/next/index.html', 'src/website/docs/docs-template.html', 'src/website/docs/www/index.html', 'src/website/www/docs/index.html']) {
    const t = read(p);
    assert.ok(!/a draw returns both stakes|A draw returns them\./.test(t), `${p}: a draw does not return the whole stake`);
    assert.match(t, /Hidden moves?,? then reveal|pick a hidden move, then reveal/, p);
    assert.match(t, /draw gives (each player )?90 % of (the|their) stake back/, `${p}: says what a draw pays`);
  }
});
