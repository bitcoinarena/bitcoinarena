// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack round 4 (settlement, season and badge awards): THE WEEKLY TOP-3 BADGE GOES BY THE RAW IDENTITY KEY ON A TIE.
// season() ranks rows by net, wins, best score - and then by `a.player < b.player`, the bare identity key. badgesEarned's season-top
// rule awards rank 1-3 by that order, so among players who tie on everything the board counts, the place is decided by whose key sorts
// lower - a key the player picks (a fresh seed until the identity starts 0x00: 256 tries per leading zero byte). The same ground key
// wins every such tie, every week, in every game - the #1614 pattern (payout ties by the raw key) in the season and its badge.
// leaderboardWinners already shares a tied place between the tied players; the badge does not.
// Safe behaviour: players that tie on everything the board ranks by are treated alike at the top-3 line - all of them get the badge,
// or none - never the ones with the lowest keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgesEarned, BADGES, WEEK_MS } from '../src/badges.js';
import { DELIVERED, FAILED } from '../src/payout.js';

const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a);
const NB = { name: 'nextblock', ids: [GAME] };
const S = 100000n;
const T0 = Date.UTC(2026, 9, 5);                 // a Monday
let keys = 0x40;
const rk = () => h(keys++);
const e = (player, outcome, score, payoutMsat) => ({ player, roundKey: rk(), outcome, score, payoutMsat, stakeMsat: S, name: null });

test('a tie at the top-3 line of the weekly board is not decided by the raw identity key', () => {
  const GRINDER = `0000${h(0x77).slice(4)}`;     // an identity ground to start 0x0000
  const W = h(0xe0);                              // the week's one winner
  const L1 = h(0x31), L2 = h(0x52), L3 = h(0x63); // three honest players who lose exactly as the grinder does
  // one round: W wins the whole pool; GRINDER, L1, L2, L3 each lose the same stake with the same FAILED score
  const rounds = [{ roundId: h(0x11), gameId: GAME, startMs: BigInt(T0 + 3600000), entries: [
    e(W, DELIVERED, 500, S * 5n), e(GRINDER, FAILED, 10, 0n), e(L1, FAILED, 10, 0n), e(L2, FAILED, 10, 0n), e(L3, FAILED, 10, 0n)] },
    // kanban #2841: all five played a paid round before the week, so each is an identity older than the week with 4 older opponents
    { roundId: h(0x10), gameId: GAME, startMs: BigInt(T0 - 86400000), entries: [W, GRINDER, L1, L2, L3].map((p) => e(p, FAILED, 1, S * 9n / 10n)) }];
  const top = BADGES.filter((b) => b.rule === 'season-top');
  const got = badgesEarned({ game: NB, rounds, nowMs: T0 + WEEK_MS + 1 }, top);
  assert.ok(got.ok, got.why);
  const awarded = new Set(got.awards.map((a) => a.player));
  assert.ok(awarded.has(W), 'the winner is on the podium');
  // GRINDER, L1, L2, L3 tie on net, wins and best score: rank 2-5 is one place, shared
  const tied = [GRINDER, L1, L2, L3];
  const inTie = tied.filter((p) => awarded.has(p));
  assert.ok(inTie.length === 0 || inTie.length === tied.length,
    `of four players tied on net, wins and best score, only ${inTie.map((p) => p.slice(0, 4)).join(', ')} got the top-3 badge - the lowest raw identity keys`);
});
