// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1483 (audit44, 683a02582), lens: the RELOAD path. A reload during a join held to its start (round=..&play=1 in the
// address) re-joins through heldRoundLink: ARENA_LOBBY_ACT.join(id, { holdUntilMs: startMs, next: true, link: true }). The page's own countdown
// for that join says "round starts in" (`next && !link`), but sayJoining's line reads only `join.next` and says "next round starts in 0:40 ·
// checking the round with the game servers" until the join is loaded - the round the player reloaded INTO is called the next one, and the line
// flips wording when it loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SRC = slice('      function joinWaitLine(', '        return join;\n      }\n');
const NOW = 1_800_000_000_000;
const make = (win) => new Function('window', 'Date', SRC + '\nreturn { joinWaitLine, sayJoining };')(win, { now: () => win.now });

test('the page: a reloaded round link is joined with next + link, and its own countdown says "round starts in"', () => {
  assert.match(HTML, /window\.ARENA_LOBBY_ACT\.join\(id, \{ holdUntilMs: startMs, next: true, link: true \}\)/);
  assert.match(HTML, /join\.stage = \(next && !link \? 'next round starts in ' : 'round starts in '\)/);
  assert.match(HTML, /const join = window\.ARENA_JOIN = \{[^}]*next: !!next \};\s*\n\s*sayJoining\(join,/);
});

test('a reloaded round link being joined says "round starts in", as its countdown does once loaded', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [] };
  const { sayJoining } = make(win);
  // the join object exactly as join() builds it for the link path: next: !!next (true); `link` is not on it
  const join = win.ARENA_JOIN = sayJoining({ state: 'joining', why: '', stage: '', round: 'r', free: false, next: true }, NOW + 40000);
  assert.ok(!/^next round/.test(join.stage), `the reloaded link's line reads "${join.stage}"`);
});
