// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCREEN THAT WAITS ON THE PLAYER IS NOT A STALL. The page's loading watch runs under the page's name
// (page-script.js) with a fake clock and screen. Measured on live UI 166 before: the watch failed with "Nothing has loaded
// for 90 seconds" behind the wallet start screen and behind the games list; a loading screen the player looks at still fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const WATCH = slice('    const LOAD_STALL_S = 90;', "    }, 1000);\n");
// the helpers after the watch, through stallMessage (before only stallMessage was there)
const HELPERS = slice(HTML.includes('    function loadWaitsOnPlayer() {') ? '    function loadWaitsOnPlayer() {' : '    function stallMessage(at, progress) {', "+ '). Check your connection and reload the page.';\n    }\n");

function run({ seconds, covered = () => false, startPending = () => false, hidden = () => false }) {
  let now = 0, tick = null;
  const bootKids = new Set(['boot-child']);
  const boot = { contains: (el) => bootKids.has(el) };
  const err = { textContent: '', classList: { contains: () => false } };
  const pct = { textContent: '0%' }, stage = { textContent: 'Connecting …' };
  const document = { getElementById: (id) => (id === 'boot' ? boot : null), elementFromPoint: () => (covered(now) ? 'games' : 'boot-child'),
    get hidden() { return hidden(now); } };
  const window = { innerWidth: 390, innerHeight: 844, ARENA_START_PENDING: () => startPending(now) };
  const failed = [];
  pageFunction(PAGE, ['document', 'window', 'boot', 'err', 'pct', 'stage', 'STAGES', 'fail', 'setInterval', 'clearInterval', 'Date', 'console'],
    [WATCH, HELPERS])(
    document, window, boot, err, pct, stage, [], (m) => failed.push(m), (fn) => { tick = fn; return 1; }, () => { tick = null; },
    { now: () => now }, { error: () => {} });
  for (; now <= seconds * 1000 && tick; now += 1000) tick();
  return { failedAt: failed.length ? now / 1000 - 1 : null, stalled: window.BLWP_LOAD_STALLED || null };
}

test('a loading screen the player looks at still fails after 90 s', () => {
  assert.equal(run({ seconds: 120 }).failedAt, 90);
});

test('the wallet start screen waits on the player: no stall in 10 minutes', () => {
  assert.equal(run({ seconds: 600, startPending: () => true, covered: () => true }).failedAt, null);
  assert.equal(run({ seconds: 600, startPending: () => true }).failedAt, null, 'the start screen alone is enough');
});

test('the games list, Settings or any page over it: no stall; the count starts when the loading screen shows again', () => {
  assert.equal(run({ seconds: 600, covered: () => true }).failedAt, null);
  assert.equal(run({ seconds: 300, covered: (t) => t < 200000 }).failedAt, 289, 'last covered at 199 s, failed 90 s later');
});

test('a tab in the background is not stalled; back in front the 90 s start again', () => {
  assert.equal(run({ seconds: 300, hidden: (t) => t < 150000 }).failedAt, 239, 'last hidden at 149 s');
});
