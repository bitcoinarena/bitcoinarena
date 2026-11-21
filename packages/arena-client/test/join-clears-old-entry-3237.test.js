// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW JOIN TAKES DOWN THE JOIN BEFORE'S SESSION SIGNAL FIRST (kanban #3237, feedback #375, 2026-11-21 16:24Z, round a71d3039):
// "Not joined PAID · 100 sats round a71d3039: Cannot read properties of null (reading 'join')" - the stake locked, no entry at any seat.
// The join before (5939ffdf) left ARENA_ENTRY, ARENA_CHAIN and ARENA_ADVERT standing: its lock was refused after the run had its entry,
// and nothing took them down. The new join set ARENA_ROUND to a71d3039 early and its entry only seconds later, so in between the bridge
// read "a session to open" (ARENA_CHAIN) for the new round with the OLD entry and opened one (arena.jslib ArenaNetStart). When the new
// entry landed, that session counted as replaced (ArenaNetEnded: ARENA_ENTRY !== pageEntry), the next ArenaNetStart set its client to
// null while its POST /round was in flight, and its `net.client.join(entry)` threw - into ARENA_ENTRY_REFUSED, which refused the page's
// join after the stake was locked. A join that ends without an entry of its own was also read as joined off the stale ARENA_ENTRY.
// Now the join takes the three down before it reads anything; the page's own code is run here on a stand-in window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');

// the join's head as the page has it: up to the round read (a stand-in that names no round ends it there)
const headSrc = (() => {
  const a = PAGE.indexOf('    async function joinTheRoundIfOneWasNamed() {');
  const cut = '      const named = await ARENACLIENT.joinFromQuery(location.search);\n      if (!named) return;\n';
  const b = PAGE.indexOf(cut, a);
  assert.ok(a > 0 && b > a, 'the page has joinTheRoundIfOneWasNamed and its round read');
  return PAGE.slice(a, b + cut.length) + '    }\n';
})();

function run(win, joinFromQuery) {
  const join = new Function('window', 'ARENACLIENT', 'location', 'performance', 'console',
    `${headSrc}\nreturn joinTheRoundIfOneWasNamed;`)(win, { joinFromQuery }, { search: '?round=a71d' }, { now: () => 0 }, { log() {} });
  return join();
}

test('#3237: a new join takes down the join before\'s entry, chain and advert before it reads the round', async () => {
  const oldEntry = { round: '5939ffdf' };
  const win = { ARENA_ENTRY: oldEntry, ARENA_CHAIN: { providers: ['old'] }, ARENA_ADVERT: { old: true }, ARENA_JOIN: { state: 'joining', round: 'a71d3039' } };
  let seen = null;
  // what the bridge would read while the round is being read - the first await of the join
  await run(win, async () => { seen = { entry: win.ARENA_ENTRY, chain: win.ARENA_CHAIN, advert: win.ARENA_ADVERT }; return null; });
  assert.deepEqual(seen, { entry: undefined, chain: undefined, advert: undefined },
    'the bridge still reads the join before\'s entry and chain while this join runs: it opens a session on the old entry');
  assert.equal(win.ARENA_ENTRY, undefined, 'a join that ends without an entry of its own is read as joined off the old one');
});

test('#3237: a page load with no join before is left as it is', async () => {
  const win = { ARENA_JOIN: null };
  await run(win, async () => null);
  assert.equal(win.ARENA_ENTRY, undefined);
  assert.equal(win.ARENA_CHAIN, undefined);
});
