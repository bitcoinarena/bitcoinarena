// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEADER'S BALANCE AFTER A STAKE (kanban #3233, feedback #336, UI 704): "After buying a 100 sat Up order in Bitcoin Up or Down, the
// toolbar still showed 2,900 sat although the wallet had already deducted the stake." The join's end summed nothing: the header waited for
// the 10 s read, and a sum already on its way when the lock spent the notes (ARENA_SUM_BALANCES answers the sum in flight) carried the
// balance before the stake. Now the join's end - picked, joined, refused - waits for any sum in flight and sums once more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');

const helperSrc = (() => {
  const a = PAGE.indexOf('          const balanceAfterStake = () => {');
  assert.ok(a > 0, 'the join has balanceAfterStake: nothing reads the balance again when a join ends');
  const b = PAGE.indexOf('\n          };\n', a);
  return PAGE.slice(a, b + 13);
})();

test('#3233: the join\'s end sums the balance again after the sum that was on its way', async () => {
  let balanceMsat = 3000000n; const shown = [];
  let summing = null;
  const win = {};
  // the page's own coalescing: a call while a sum runs answers that sum
  win.ARENA_SUM_BALANCES = () => summing || (summing = (async () => { const read = balanceMsat; await new Promise((r) => setTimeout(r, 20)); shown.push(Number(read / 1000n)); })().finally(() => { summing = null; }));
  win.ARENA_SUM_BALANCES();               // the 10 s read, started before the lock spent its notes
  balanceMsat -= 100000n;                 // the stake's lock
  const balanceAfterStake = new Function('window', `${helperSrc}\nreturn balanceAfterStake;`)(win);
  await balanceAfterStake();
  assert.equal(shown.at(-1), 2900, 'the header keeps the balance before the stake: ' + JSON.stringify(shown));
});

test('#3233: every end of the join reads the balance again', () => {
  const a = PAGE.indexOf('          joinTheRoundIfOneWasNamed()\n            .then(() => {');
  const b = PAGE.indexOf('          return answer(true, \'started\');', a);
  const tail = PAGE.slice(a, b);
  assert.match(tail, /\.then\(\(\) => \{\n\s+join\.committed = true;\n\s+balanceAfterStake\(\);/, 'the join\'s answer does not read the balance again');
  assert.match(tail, /\.catch\(\(e\) => \{\n\s+balanceAfterStake\(\);/, 'a join that threw does not read the balance again');
});

test('#3233: no sum function yet is no error', async () => {
  const balanceAfterStake = new Function('window', `${helperSrc}\nreturn balanceAfterStake;`)({});
  await balanceAfterStake();
});
