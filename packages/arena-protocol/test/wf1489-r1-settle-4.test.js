// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-settle-4: A BYPASS OF #2450 (leaderboard payout from the reserves). #2450 keeps an identity that staked nothing
// off the winners, because a net of 0 ranks above every paying player who lost and fresh identities would share every place the
// net-positive players leave open. But the rule is only `stakedMsat > 0`: an identity that plays ONE paid round alone - its own net
// stake back as the sole qualifier, only the 10 % fee lost - nets -10 % of one stake, which still ranks above every honest player
// who lost a game. 20 such identities cost 20 fees and take every place the winners leave open, from the reserves.
// Safe: a reserves-funded place goes only to an identity that won money in the window (net > 0), so no farm of near-free losers
// can fill the places left open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboardWinners } from '../src/leaderboard-winners.js';

const hx = (n) => n.toString(16).padStart(64, '0');
const GAME = 'aa'.repeat(32);
const FROM = 1_000_000n, TO = FROM + 7n * 86400000n;
const S = 100000n;                 // a 100 sat round

test('wf1489 r1-settle-4: identities that only paid one round\'s fee take no leaderboard place from the reserves', () => {
  const rounds = [];
  // one honest paid round: A wins the pool, B, C, D lose their stakes
  const paid = [{ id: 0xa, pay: 370000n, score: 9 }, { id: 0xb, pay: 0n, score: 1 }, { id: 0xc, pay: 0n, score: 1 }, { id: 0xd, pay: 0n, score: 1 }];
  rounds.push({ roundId: hx(1), gameId: GAME, startMs: FROM + 10n, entries: paid.map((p) => ({
    player: hx(0x1000 + p.id), roundKey: hx(0x2000 + p.id), stakeMsat: S, payoutMsat: p.pay, outcome: 'DELIVERED', score: p.score, name: null })) });
  // the attacker: 20 fresh identities, each alone in a paid round - sole qualifier, its net stake (90 %) back, the fee lost
  for (let i = 0; i < 20; i++) {
    rounds.push({ roundId: hx(100 + i), gameId: GAME, startMs: FROM + 100n + BigInt(i), entries: [
      { player: hx(0x9000 + i), roundKey: hx(0x8000 + i), stakeMsat: S, payoutMsat: (S * 90n) / 100n, outcome: 'DELIVERED', score: 1, name: null }] });
  }
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 3, amountMsat: 3_000_000n });
  assert.equal(w.ok, true, w.why);
  const sybils = new Set(Array.from({ length: 20 }, (_, i) => hx(0x9000 + i)));
  const toSybils = w.winners.filter((x) => sybils.has(x.player)).reduce((t, x) => t + BigInt(x.msat), 0n);
  const feesPaid = 20n * (S / 10n);
  console.log('  FACTS:', JSON.stringify({ winners: w.winners.map((x) => ({ p: x.player.slice(-4), net: x.netMsat, msat: String(x.msat), places: x.places })), toSybils: String(toSybils), feesPaid: String(feesPaid) }));
  assert.equal(toSybils, 0n, `${toSybils} msat of the 3000000 msat reserves payout went to ${w.winners.filter((x) => sybils.has(x.player)).length} identities that only paid ${feesPaid} msat of fees between them`);
  assert.ok(w.winners.every((x) => BigInt(x.netMsat) > 0n), 'a reserves-funded place went to an identity that lost money in the window');
});
