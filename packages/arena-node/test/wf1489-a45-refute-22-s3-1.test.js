// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45-refute-22-s3: #1856's second copy. #1856/#2273/#2355 bound what ONE seat's GET /season-rounds costs this seat
// ("one verify per round it was drawn for"). The leaderboard payout also reads every guardian peer's GET /leaderboard-winners
// (server.js payoutPeer.winners: a bare `r.json()`, 30 s) and merges its `evidence` with this seat's own (winnersBook.union /
// check) through mergeSignedSeasonAccounts - no bound, no honest-shape filter. One guardian seat repeats one real round's evidence
// with signatures "of" every seat of its draw that do not verify: a failed signature is never remembered, so every copy is
// schnorr-verified again in the main thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createWinnersBook, FREEZE_GRACE_MS } from '../src/leaderboard-freeze.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { contractRound, answersOf, drawOf, seatKey } from './signed-season-fixture.js';

const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a);
const T0 = Date.UTC(2026, 9, 10);
const S = 100000n;
const en = (player, payoutMsat, roundKey) => ({ player, roundKey, name: null, stakeMsat: S, payoutMsat, outcome: payoutMsat > S ? DELIVERED : FAILED, score: 1 });
const [A, B] = [0x0a, 0x0b].map(h);
const R1 = contractRound({ gameId: GAME, startMs: T0 + 3600000, n: 1, entries: [en(A, 2n * S, h(0xa1)), en(B, 0n, h(0xb1))] });
const SEASON = { games: [GAME], fromMs: T0, toMs: T0 + 7 * 86400000, top: 3, amountMsat: 3000000n, splitBps: [] };
const DRAW = drawOf(new Map(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
const COPIES = 3000;

test('a45-refute-22-s3-1: one guardian peer\'s padded /leaderboard-winners evidence costs at most one verify per (account, seat)', async () => {
  let calls = 0;
  const verify = (s, m, k) => { calls++; if (s[0] === 0xee) return false; return schnorr.verify(s, m, k); };
  const db = openStore(':memory:');
  const book = createWinnersBook({ db, paramsOf: async () => ({ ok: true, ...SEASON }), collect: async () => answersOf([R1]),
    seatsOf: DRAW, verify, now: () => SEASON.toMs + FREEZE_GRACE_MS });
  const f = await book.freeze('cc'.repeat(32));
  assert.equal(f.ok, true, f.why);
  const own = book.recordOf('cc'.repeat(32));
  assert.ok(own.evidence.length >= 1);
  // the peer's GET /leaderboard-winners: this one real account, COPIES times, each "signed" by all nine seats of its draw with garbage
  const e = own.evidence[0];
  const bad = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ node: seatKey(n), sig: 'ee'.repeat(64) }));
  // seats 1-5 signed for real (answersOf): the merge counts each once; 6-9 never verify, so are never remembered
  const padded = Array.from({ length: COPIES }, () => ({ ...e, sigs: bad }));
  const before = calls;
  const t0 = Date.now();
  const u = await book.union('cc'.repeat(32), [padded]);
  const spent = calls - before;
  assert.equal(u.ok, true, u.why);
  console.log(`a45-refute-22-s3-1: ${COPIES} copies of one account from one peer -> ${spent} verify calls, ${Date.now() - t0} ms`);
  // honest bound: the own evidence (5 sigs) plus one try per draw seat of the one account the peer names
  assert.ok(spent <= 5 + 9, `one guardian peer's ${COPIES} copies of one account cost ${spent} verify calls (bound 14)`);
});
