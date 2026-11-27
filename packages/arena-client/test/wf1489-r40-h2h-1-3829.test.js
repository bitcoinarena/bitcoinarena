// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r40-h2h-1 (gap in #1497 / #1502 / #2709 on the live topology, the #3187 / #3204 collapse in revealsOfRound):
// revealsOfRound takes an entry's move when `need = min(2, hosts)` hosts name it. The live seats all sit on ONE tunnel host
// (https://tn4.../guardian-1..7), so hosts = 1 and need = 1, and the host's word is the plurality of the addresses that ANSWERED a move.
// In a paying protocol-28 round the honest seats serve no move until they hold the certified lock set (GET /reveals answers
// `reveals: []`, lockSet 'pending'), so in the first second after the close one colluding seat of 7 serving both moves - the player's
// own (right) and a made-up opponent move - is the only address naming anything: its move is "agreed". The page caches any answer
// naming two entries for good (index.html revealsSeen) and draws the provisional verdict and the RPS show from it.
// SAFE: on a one-host list of seven seats, one seat's word alone is not the opponent's move - at least two seats must name it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsOfRound } from '../src/head-to-head.js';

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32);
const ROCK = 0, PAPER = 1;

test('#1489 r40-h2h-1: one seat of seven on one tunnel host does not decide the opponent\'s move shown', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => `https://tn4.example/guardian-${i + 1}`);
  const fetcher = async (url) => {
    // guardian-1 colludes: serves the move at once, the opponent's made up (paper beats my rock)
    const said = url.startsWith('https://tn4.example/guardian-1/') ? { reveals: [{ entry: ME, move: ROCK }, { entry: THEM, move: PAPER }] }
      : { reveals: [], lockSet: 'pending' };   // honest seats: no certificate yet, no move public
    return { ok: true, status: 200, text: async () => JSON.stringify(said) };
  };
  const got = await revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes, fetcher });
  console.log('  FACTS:', JSON.stringify({ got }));
  assert.equal(got[THEM], undefined, `one seat of seven decided the opponent's move shown: ${JSON.stringify(got)}`);
});
