// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3289 (owner 2026-11-22: "Das Laden des Leaderboards dauert auch zu lang"): measured on the stage, no seat built its network season
// within the page's 12 s (they take 22-50 s), the first four were raced and every other seat was then asked ONE AFTER ANOTHER, 12 s each -
// two minutes before the board's next ask. Past the first `race` seats the rest are raced too, `race` at a time; the board shown is still
// one seat's network answer, whose rows count only where 3 seats agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeason } from '../src/season-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const good = { node: key(0x01), game: { name: 'nextblock', ids: [key(0x0a)] }, days: 7, from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z',
  fromMs: 1, toMs: 2, rows: [], rounds: 41, leftOut: 0, unchecked: [], scope: 'network', agree: 3, seats: { asked: 12, answered: 12 } };

test('past the first seats raced, the rest are raced too, not asked one after another', async () => {
  const asked = [];
  const fetch = (url, { signal } = {}) => new Promise((resolve, reject) => {
    asked.push(url);
    if (url.startsWith('https://good.example')) return setTimeout(() => resolve({ ok: true, status: 200, json: async () => good }), 20);
    if (signal) signal.addEventListener('abort', () => reject(new Error('timed out')));
  });
  const t0 = Date.now();
  const v = await fetchSeason({ nodes: ['https://h1.example', 'https://h2.example', 'https://h3.example', 'https://h4.example', 'https://good.example'],
    game: 'nextblock', days: 7, fetch, answerMs: 300, timeout: (ms) => AbortSignal.timeout(ms), race: 2 });
  const took = Date.now() - t0;
  assert.equal(v.ok, true);
  assert.equal(v.seat, 'https://good.example');
  assert.ok(took < 650, `answered after ${took} ms`);
  assert.equal(asked.length, 5);
});

test('the page races eight of the game\'s seats and gives a network season the time a seat takes to build it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(src, /viewer: viewer\(\), fetch: \(u, o\) => fetch\(u, o\), via, timeout, race: 8, answerMs: 45000 \}\);/);
});
