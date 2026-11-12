// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 R4 H2H-1: revealsOfRound (the page's ARENA_GAME.reveals) asks every seat of the round for GET /reveals with no deadline: a fetch with no
// signal, then r.json() of an unbounded body, all in one Promise.all. ONE seat of the seven that answers its headers and never ends its body (or never
// answers at all) holds the call forever. The Rock Paper Scissors client awaits it inside refresh() behind a `refreshing` flag, so from that round on
// refresh never runs again: no opponent move, no verdict, no lobby counts, until the tab is reloaded - and the next round's call hangs the same way.
// SAFE: the call resolves within a bounded time with the moves the honest seats agree on, whatever one seat does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsOfRound } from '../src/head-to-head.js';

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32);
test('wf1489-r4-h2h-1: one silent seat does not hold the page\'s read of a round\'s reveals forever', async () => {
  const fetcher = (url, init = {}) => {
    if (url.startsWith('http://silent')) {
      // headers never come; only an abort (a deadline the caller sets) ends it
      return new Promise((_, rej) => { const s = init && init.signal; if (s) s.addEventListener('abort', () => rej(new Error('aborted'))); });
    }
    return Promise.resolve({ ok: true, json: async () => ({ reveals: [{ entry: ME, move: 1 }, { entry: THEM, move: 0 }] }) });
  };
  const t0 = Date.now();
  const LIMIT = 20000;
  const got = await Promise.race([
    revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes: ['http://a', 'http://b', 'http://silent'], fetcher }),
    new Promise((r) => { const t = setTimeout(() => r('STILL WAITING'), LIMIT); t.unref?.(); }),
  ]);
  console.log(`  FACTS after ${Date.now() - t0} ms revealsOfRound answered: ${JSON.stringify(got).slice(0, 120)}`);
  assert.notEqual(got, 'STILL WAITING', `one silent seat held revealsOfRound for ${LIMIT / 1000} s and more: the RPS client's refresh() never runs again`);
  assert.equal(got[THEM], 0);
});
