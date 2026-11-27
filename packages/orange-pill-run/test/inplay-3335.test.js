// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3335 (owner 2026-11-22 "Es ruckelt immer noch!" in the Arena page): a run in play holds the page's background work. The game calls
// bridge.playing(true) at every start and playing(false) at every end; the page's pollers and the owed scan wait while ARENA_OPR_IN_PLAY().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const main = readFileSync(new URL('../client/src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const dist = readFileSync(new URL('../client/dist/index.html', import.meta.url), 'utf8');

test('#3335 the game says a run starts and ends (begin, finish, a stopped replay); its 1 s repaint is off during a run', () => {
  const body = (name) => main.slice(main.indexOf(`function ${name}(`), main.indexOf('\n}', main.indexOf(`function ${name}(`)));
  assert.match(body('begin'), /inPlay\(true\)/);
  assert.match(body('finish'), /inPlay\(false\)/);
  assert.match(body('stopReplay'), /inPlay\(false\)/);
  assert.match(main, /setInterval\(\(\) => \{ if \(running\) return;/);
  assert.match(dist, /bridge\.playing\(!!on\)/, 'client/dist rebuilt');
});

test('#3335 the page: bridge.playing sets the flag; ARENA_OPR_IN_PLAY holds at most 4 min; every background job checks it', () => {
  for (const s of ['playing: (on) => { window.ARENA_OPR_PLAYING = on ? Date.now() : 0; }', 'window.ARENA_OPR_IN_PLAY = () =>']) assert.ok(page.includes(s), s);
  const n = (page.match(/ARENA_OPR_IN_PLAY\(\)/g) || []).length;
  assert.ok(n >= 9, `${n} checks`);   // liquidation claims, owed scan, payout, pending, balance, 2 x block count, lobby 1 s, lobby 5 s
  const line = page.split('\n').find((l) => l.includes('window.ARENA_OPR_IN_PLAY = () =>'));
  const win = {}; let t = 1_000_000; vm.runInNewContext(line, { window: win, Date: { now: () => t } });
  assert.equal(win.ARENA_OPR_IN_PLAY(), false);
  win.ARENA_OPR_PLAYING = t; assert.equal(win.ARENA_OPR_IN_PLAY(), true);
  t += 239000; assert.equal(win.ARENA_OPR_IN_PLAY(), true);
  t += 2000; assert.equal(win.ARENA_OPR_IN_PLAY(), false);   // a lost "ended" never stops the page for good
  win.ARENA_OPR_PLAYING = 0; assert.equal(win.ARENA_OPR_IN_PLAY(), false);
});
