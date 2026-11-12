// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM6 PAGE-2: a head-to-head move's salt lives in the TAB (sessionStorage 'arena.h2h.moves'), while the phrase that staked it lives in
// the BROWSER (localStorage 'arena.seeds', kept since 2026-10-01 "It needs to be persisted"). A player who makes a move and closes the tab (the
// round closes minutes later) comes back in a new tab: the seed keeper gives that tab the same phrase, the collect finds the round, the stake
// lock is this browser's - and the move can never be revealed, because the salt went with the closed tab's sessionStorage. The reveal needs
// nothing else (revealMove posts { move, salt } for the entry id); the unrevealed entry forfeits its stake. The page's own slices: a move kept
// by tab 1, read by tab 2 on the same browser storage and the same phrase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a >= 0, 'slice start'); const b = HTML.indexOf(to, a); assert.ok(b > a, 'slice end'); return HTML.slice(a, b + to.length); };
const KEEP = slice('    function hiddenFor(roundIdHex)', '    window.ARENA_HIDDEN_MOVES = readHidden;');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const tab = (localStorage, sessionStorage) => new Function('window', KEEP + '\n return { rememberHidden, readHidden };')({ localStorage, sessionStorage });

test('wf1489-sm6-page-2: a hidden move made in this browser can still be revealed from a new tab of the same phrase', () => {
  const PHRASE = '6c'.repeat(32), ROUND = 'cd'.repeat(32);
  const L = mem();                                      // the browser's storage: the phrase is kept here (arena.seeds)
  L.setItem('arena.seeds', JSON.stringify([{ hex: PHRASE, from: 'minted', at: 1 }]));
  const S1 = mem(); S1.setItem('arena.player.seed', PHRASE);
  const t1 = tab(L, S1);
  t1.rememberHidden({ roundIdHex: ROUND, entryIdHex: 'ee'.repeat(32), move: 2, saltHex: '11'.repeat(32), nodes: ['http://seat1'], entryCloseMs: String(Date.now() + 120000) });
  assert.ok(t1.readHidden().some((h) => h.roundIdHex === ROUND), 'the fixture: tab 1 keeps its move');
  // tab 1 is closed before the entry close; a new tab of this browser takes the same kept phrase (arenaSeedKeeper: a free kept phrase)
  const S2 = mem(); S2.setItem('arena.player.seed', JSON.parse(L.getItem('arena.seeds'))[0].hex);
  const t2 = tab(L, S2);
  const found = t2.readHidden().find((h) => h.roundIdHex === ROUND) || null;
  console.log('  FACTS wf1489-sm6-page-2:', JSON.stringify({ samePhrase: S2.getItem('arena.player.seed') === PHRASE, tab1Has: true, tab2Has: !!found,
    browserKeys: [...L.m.keys()], tab1Keys: [...S1.m.keys()] }));
  assert.ok(found && found.saltHex, 'the phrase and its stake lock are this browser\'s, the move\'s salt was only the closed tab\'s: the move can never be revealed and the stake forfeits');
});
