// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r25-settle-1: A BYPASS OF #2656 (and #2450). The reserves-funded leaderboard payout now pays a place only to an
// identity with netMsat > 0. But a positive net is free to make between two of one's own identities: a sock pair plays a paid
// round together, the loser FAILS, the winner takes the loser's net stake. The winner nets +80 % of a stake, the loser -100 %
// (skipped), and the attacker's only real cost is the two entries' fees - the loser's stake is the attacker's own money moved
// to its other key. Each pair fills one place the honest net-positive players leave open.
// Safe: a place paid from the reserves is not bought for two fees by moving stake between one's own identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboardWinners } from '../src/leaderboard-winners.js';

const hx = (n) => n.toString(16).padStart(64, '0');
const GAME = 'aa'.repeat(32);
const FROM = 1_000_000n, TO = FROM + 7n * 86400000n;
const S = 100000n;                 // a 100 sat round
const NET = (S * 90n) / 100n;      // 10 % fee and donation out of the stake

test('wf1489 r25-settle-1: sock pairs that move stake between their own identities buy no leaderboard place for two fees', () => {
  const rounds = [];
  // one honest paid round: A wins the pool, B, C, D lose their stakes
  const paid = [{ id: 0xa, pay: NET * 4n, score: 9, out: 'DELIVERED' }, { id: 0xb, pay: 0n, score: 0, out: 'FAILED' },
    { id: 0xc, pay: 0n, score: 0, out: 'FAILED' }, { id: 0xd, pay: 0n, score: 0, out: 'FAILED' }];
  rounds.push({ roundId: hx(1), gameId: GAME, startMs: FROM + 10n, entries: paid.map((p) => ({
    player: hx(0x1000 + p.id), roundKey: hx(0x2000 + p.id), stakeMsat: S, payoutMsat: p.pay, outcome: p.out, score: p.score, name: null })) });
  // the attacker: 2 sock pairs; in each paid round its loser key fails and its winner key takes the loser's net stake
  for (let i = 0; i < 2; i++) {
    rounds.push({ roundId: hx(100 + i), gameId: GAME, startMs: FROM + 100n + BigInt(i), entries: [
      { player: hx(0x9000 + i), roundKey: hx(0x8000 + i), stakeMsat: S, payoutMsat: NET * 2n, outcome: 'DELIVERED', score: 1, name: null },
      { player: hx(0x7000 + i), roundKey: hx(0x6000 + i), stakeMsat: S, payoutMsat: 0n, outcome: 'FAILED', score: 0, name: null }] });
  }
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 3, amountMsat: 3_000_000n });
  assert.equal(w.ok, true, w.why);
  const socks = new Set([0x9000, 0x9001, 0x7000, 0x7001].map(hx));
  const toSocks = w.winners.filter((x) => socks.has(x.player)).reduce((t, x) => t + BigInt(x.msat), 0n);
  const feesPaid = 4n * (S - NET);   // the attacker's only cost: four entries' fees (the losers' net stakes went to its own winners)
  console.log('  FACTS:', JSON.stringify({ winners: w.winners.map((x) => ({ p: x.player.slice(-4), net: x.netMsat, msat: String(x.msat), places: x.places })), toSocks: String(toSocks), feesPaid: String(feesPaid) }));
  assert.equal(toSocks, 0n, `${toSocks} msat of the 3000000 msat reserves payout went to an attacker's sock identities that cost it ${feesPaid} msat of fees`);
});
