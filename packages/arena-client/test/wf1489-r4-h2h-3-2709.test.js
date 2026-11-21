// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r4-h2h-3: revealsOfRound (the page's ARENA_GAME.reveals, the open moves the provisional verdict is drawn from) counts
// one vote per ADDRESS of the hidden record's node list - the join link's. #2329/#2364 made the signed-result read (index.html result()) one vote per
// server: one seat named twice ('http://evil' and 'http://evil/'), or under two paths of one host, outvoted the honest seat. revealsOfRound kept the
// old rule, so the same link makes one dishonest seat two votes for the opponent's move, and the page shows its verdict (a win turned into a loss)
// for the first seconds after the close - the very flip #1502 / #1489 closed.
// Safe: one server is one vote; a move only it names, against an honest seat's, is not taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsOfRound } from '../src/head-to-head.js';

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32);
const ROCK = 0, PAPER = 1, SCISSORS = 2;

test('#1489 r4-h2h-3: one seat listed under two spellings is one vote in revealsOfRound', async () => {
  // I played rock; the opponent really played scissors (I win). The dishonest seat says paper (I lose).
  const fetcher = async (url) => {
    const said = url.startsWith('http://evil') ? [{ entry: ME, move: ROCK }, { entry: THEM, move: PAPER }] : [{ entry: ME, move: ROCK }, { entry: THEM, move: SCISSORS }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ reveals: said }) };
  };
  const nodes = ['http://evil.example', 'http://evil.example/', 'http://honest.example'];
  const got = await revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes, fetcher });
  console.log('  FACTS:', JSON.stringify({ nodes, got }));
  assert.notEqual(got[THEM], PAPER, `one server named twice decided the opponent's move shown: ${JSON.stringify(got)}`);
});
