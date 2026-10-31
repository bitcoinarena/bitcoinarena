// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOAD ENDS WITH EVERY SCREEN (kanban #834) AND THE LINE UNDER THE PAGE IS NEVER DEAD (kanban #835).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');

test('every screen that is not the area ends the load, and a sign-in counts again', () => {
  const load = HTML.slice(HTML.indexOf('const LOAD = {'), HTML.indexOf('function drawLoad()'));
  const end = HTML.slice(HTML.indexOf('const loadEnd = '), HTML.indexOf('\n// THE RELEASE THIS NODE RUNS'));
  const els = { loadbar: { hidden: false }, 'loadbar-i': { style: {} }, 'loadbar-t': {} };
  const LOAD_END = new Function('document', `${load}\n${HTML.slice(HTML.indexOf('function drawLoad()'), HTML.indexOf('\n{\n  const inner'))}\n${end}\nLOAD.started = 2; LOAD.done = 2; return { LOAD, loadEnd, loadAgain };`)({ getElementById: (id) => els[id] || null });
  LOAD_END.loadEnd();
  assert.deepEqual([LOAD_END.LOAD.over, els.loadbar.hidden], [true, true], 'over at once, and the bar gone');
  LOAD_END.loadAgain();
  assert.deepEqual([LOAD_END.LOAD.over, LOAD_END.LOAD.area, LOAD_END.LOAD.started, LOAD_END.LOAD.done], [false, false, 0, 0]);
  for (const screen of ['function welcome() { loadEnd();', 'function claim(mine, file) { loadEnd();', 'const message = (props) => { loadEnd();']) assert.ok(HTML.includes(screen), screen);
  const start = HTML.slice(HTML.indexOf('async function start()'));
  assert.match(start, /This node did not answer: ' \+ e\.message; loadEnd\(\); return;/);
  assert.match(start, /Try again in a minute\.'; loadEnd\(\); return;/);
  assert.match(HTML, /const loaded = \(p\) => import\(at\(p\)\)\.catch\(\(e\) => \{[^\n]*loadEnd\(\); throw e; \}\);/);
  assert.match(HTML, /onIn: \(\) => \{ me = null; loadAgain\(\); start\(\); \}/);
});

test('no href="#": the line under the page is hidden or goes somewhere real', () => {
  assert.doesNotMatch(HTML.replace(/<script[\s\S]*?<\/script>/g, ''), /href="#"/);
  assert.match(HTML, /if \(ON_SITE\) publicLink\('\/', '← Bitcoin Arena'\);/);
  const start = HTML.slice(HTML.indexOf('async function start()'));
  assert.ok(start.indexOf("answers as another node") < start.indexOf("publicLink(at('/Dashboard'), '← Node dashboard')"), 'the node\'s dashboard only once the node answered as itself');
});
