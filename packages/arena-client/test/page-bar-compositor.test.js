// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOADING BAR MOVES ON THE COMPOSITOR (2026-10-16: two amber bars - the bar and, from 90 %, a second one -
// and "100 %" with the bar half full). Measured by screencast at 10x CPU on live UI 167: the bar's width transition (main
// thread) froze at 75 % while Unity held the main thread and the creep (a transform) ran from 90 % beside it. On the page's own
// code: the bar is moved by a transform only, its transition is a transform's, and the creep waits for the bar's move to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const rule = (sel) => { const m = HTML.match(new RegExp('\\n\\s*' + sel.replace(/[.#]/g, '\\$&') + ' \\{([^}]*)\\}')); assert.ok(m, sel); return m[1]; };
const seconds = (t) => Number(t.replace(/s$/, ''));

test('the bar is moved by a transform, never by its width', () => {
  const from = HTML.indexOf('    function show(p) {');
  const src = HTML.slice(from, HTML.indexOf('\n    }\n', from) + 6);
  const bar = { style: {} };
  const el = () => ({ classList: { add() {}, remove() {} } });
  const show = pageFunction(PAGE, ['bar', 'pct', 'stage', 'subStep', 'TOTAL_MB', 'STAGES', 'document'], src, 'return show;')(
    bar, { textContent: '', dataset: {} }, { textContent: '' }, 0, '', [[0, 'x']], { getElementById: el });
  show(0.5); assert.equal(bar.style.width, undefined, 'no width written'); assert.equal(bar.style.transform, 'translateX(-50.0%)');
  show(0.9); assert.equal(bar.style.transform, 'translateX(-10.0%)');
  show(1); assert.equal(bar.style.transform, 'translateX(0.0%)');
});

test('the bar\'s own move is a transform transition, and the creep starts when it has ended', () => {
  const bar = rule('#bar');
  assert.match(bar, /width: 100%/); assert.match(bar, /transform: translateX\(-100%\)/);
  const tr = bar.match(/transition: (\S+) ([\d.]+s)/); assert.ok(tr, 'the bar has a transition');
  assert.equal(tr[1], 'transform', 'a transform transition runs on the compositor; a width one stops with the main thread');
  const creep = rule('#creep.on').match(/animation: creep90 [\d.]+s \S+\([^)]*\) ([\d.]+s) forwards/);
  assert.ok(creep, 'the creep has a delay');
  assert.ok(seconds(creep[1]) >= seconds(tr[2]), 'the creep waits for the bar to reach 90 %');
});
