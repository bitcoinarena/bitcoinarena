// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE LOADING BAR, NOT TWO (2026-10-11: "The progress bar while loading is split in two: one stretch to 90,
// then another to 100. It should be one bar."). Measured in Chrome at 3x: at 90 % the bar ended in a rounded cap and the
// creep layer (90 -> 99 %) began after it in a lighter gradient of its own - a notch and a colour step. On the
// page's own code: while the creep runs the bar's end is square, the creep starts on the bar's end colour, and the bar is
// marked creeping exactly while the creep runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
// the creep and its square end are Tick Tock's loading-screen CSS (kanban #521): the page's style and the game's, read together
const STYLE = HTML + '\n' + readFileSync(new URL('../../nextblock/page/unity-page.css', import.meta.url), 'utf8');

test('the bar and the creep join as one: square end while creeping, the creep starting on the bar\'s end colour', () => {
  assert.match(STYLE, /#track\.creeping #bar \{ border-top-right-radius: 0; border-bottom-right-radius: 0; \}/);
  const barEnd = STYLE.match(/#bar \{[^}]*linear-gradient\(90deg, #f7931a, (#[0-9a-f]{6})\)/)[1];
  const creepStart = STYLE.match(/#creep \{[^}]*linear-gradient\(90deg, (#[0-9a-f]{6}),/)[1];
  assert.equal(creepStart, barEnd, 'the creep starts on the colour the bar ends on');
});

test('the track is marked creeping from 90 % until 100 %, as the creep runs', () => {
  const from = HTML.indexOf("      if (clamped >= 0.9 && clamped < 1 && pct.dataset.unity !== '90') {");
  const to = HTML.indexOf('\n    }\n', from);
  const src = HTML.slice(from, to);
  const classes = (id) => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), has: (c) => s.has(c) }; };
  const els = { creep: { classList: classes() }, track: { classList: classes() }, pctwrap: { classList: classes() } };
  const document = { getElementById: (id) => els[id] || null };
  const later = [];
  const step = pageFunction(PAGE, ['document', 'pct', 'clamped', 'setTimeout'], src, 'return 0;');
  const pct = { dataset: {} };
  const at = (c) => step(document, pct, c, (fn, ms) => later.push([fn, ms]));
  at(0.5); assert.equal(els.track.classList.has('creeping'), false);
  at(0.9); assert.equal(els.track.classList.has('creeping'), true); assert.equal(els.creep.classList.has('on'), true);
  at(1); assert.equal(els.creep.classList.has('on'), true, 'the creep stays while the bar slides to 100 %');
  assert.deepEqual(later.map(([, ms]) => ms), [250], 'and goes when the bar\'s 0.25 s move has ended');
  later[0][0](); assert.equal(els.track.classList.has('creeping'), false); assert.equal(els.creep.classList.has('on'), false);
});
