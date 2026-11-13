// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12: the `bot` mark is not part of a signed season account, yet the merged round keeps the FIRST copy's entries.
// One seat (or any peer whose /season-rounds answer is read first) hands in an honest round with the leaderboard leader marked
// bot: true and no signature at all; the five honest seats' signatures land on the same account id, and the leader is dropped
// from the leaderboard payout's winners (and the weekly badge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { mergeSignedSeasonAccounts } from '../src/season.js';
import { leaderboardWinners } from '../src/leaderboard-winners.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { contractRound, seatAnswer, drawOf } from '../../arena-node/test/signed-season-fixture.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a);
const T0 = Date.UTC(2026, 9, 10);
const S = 100000n;
const en = (player, payoutMsat, roundKey) => ({ player, roundKey, name: null, stakeMsat: S, payoutMsat, outcome: payoutMsat > S ? DELIVERED : FAILED, score: 1 });
const [A, B, C] = [0x0a, 0x0b, 0x0c].map(h);
const R1 = contractRound({ gameId: GAME, startMs: T0 + 3600000, n: 1, entries: [en(A, 3n * S, h(0xa1)), en(B, 0n, h(0xb1)), en(C, 0n, h(0xc1))] });
const DRAW = drawOf(new Map([[R1.roundId, [1, 2, 3, 4, 5, 6, 7, 8, 9]]]));
const WINDOW = { games: [GAME], fromMs: T0, toMs: T0 + 7 * 86400000, top: 1, amountMsat: 1000000n };

test('a copy of a signed round with the winner marked bot, signed by nobody, does not take the winner off the payout', () => {
  const honest = [1, 2, 3, 4, 5].map((n) => seatAnswer(n, [R1]));
  const forged = [{ ...honest[0][0], entries: honest[0][0].entries.map((e) => (e.player === A ? { ...e, bot: true } : e)), sigs: [] }];
  const clean = mergeSignedSeasonAccounts(honest, { seatsOf: DRAW, verify });
  assert.equal(leaderboardWinners({ ...WINDOW, rounds: clean.rounds }).winners[0].player, A, 'honest board: A wins');
  const m = mergeSignedSeasonAccounts([forged, ...honest], { seatsOf: DRAW, verify });
  assert.equal(m.ok, true);
  const w = leaderboardWinners({ ...WINDOW, rounds: m.rounds });
  assert.equal(w.winners[0] && w.winners[0].player, A, `A signed winner by 5 seats must stay first; got ${JSON.stringify(w.winners.map((x) => x.player.slice(0, 4)))}, A's merged bot mark ${m.rounds[0].entries.find((e) => e.player === A).bot}`);
});
