// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1483 (audit44, 90d57151a): sayJoining reads the join's stage as joinWaitLine while the join is 'joining' and not
// `loaded`. A FREE round joined before its start is never `loaded` (ARENA_JOIN_LOADED is called only on the paid lock path), yet once its
// entry is in it is HELD to the start: `join.held = true; join.stage = startsIn()`. Its stage then reads
// "round starts in 0:40 · checking the round with the game servers" for the whole wait - an entered player is told the join is still
// being checked; before #1483 the stage was "round starts in 0:40". The order strip already treats `held` as shown loaded; the getter does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SRC = slice('      function joinWaitLine(', '        return join;\n      }\n');
const NOW = 1_800_000_000_000;
const make = (win) => new Function('window', 'Date', SRC + '\nreturn { joinWaitLine, sayJoining };')(win, { now: () => win.now });

test('the page: a free join is held to its start without ever being loaded', () => {
  // holdUntilMs is the round's start for every join (free too)
  assert.match(HTML, /if \(!holdUntilMs\) \{ const st = Number\(\(r\.raw && r\.raw\.startTimeMs\) \|\| 0\); if \(st > Date\.now\(\)\) holdUntilMs = st; \}/);
  // ARENA_JOIN_LOADED is called only once (the paid lock path, after `if (thisJoin && !thisJoin.free && ...)`)
  assert.equal((HTML.match(/window\.ARENA_JOIN_LOADED\(\)/g) || []).length, 1);
  // the held branch sets held + the raw countdown, not loaded
  assert.match(HTML, /join\.stage = startsIn\(\);\s*\n\s*join\.held = true;/);
});

test('an entered free join held to its start says its countdown, not "checking the round with the game servers"', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [] };
  const { sayJoining } = make(win);
  const join = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: '', round: 'r', free: true }, NOW + 40000);
  // the entry is in (ARENA_ENTRY set), the join is held to the start exactly as index.html's release() does it
  join.stage = 'round starts in 0:40';
  join.held = true;
  assert.ok(!/checking the round/.test(join.stage), `the held join's stage reads "${join.stage}"`);
  assert.equal(join.stage, 'round starts in 0:40');
});
