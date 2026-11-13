// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit #1489 r11 (settlement/payout, leaderboard payout from the reserves): an identity that staked nothing in the
// season - free rounds only - must not take a place of a reserves-funded leaderboard payout. A free round costs nothing,
// so its net is 0, which ranks above every paying player who lost; a stranger who joins free rounds under many fresh
// identities then shares every place the net-positive players do not fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboardWinners } from '../src/leaderboard-winners.js';

const hx = (n) => n.toString(16).padStart(64, '0');
const GAME = 'aa'.repeat(32);
const FROM = 1_000_000n, TO = FROM + 7n * 86400000n;

test('wf1489 r11 settle-1: free-round sybil identities take no leaderboard payout place', () => {
  const rounds = [];
  // one paid round: identity A wins, B, C, D lose (their stakes are A's win)
  const paid = [
    { id: 0xa, stake: 100000n, pay: 370000n, score: 9 },
    { id: 0xb, stake: 100000n, pay: 0n, score: 1 },
    { id: 0xc, stake: 100000n, pay: 0n, score: 1 },
    { id: 0xd, stake: 100000n, pay: 0n, score: 1 },
  ];
  rounds.push({ roundId: hx(1), gameId: GAME, startMs: FROM + 10n, entries: paid.map((p) => ({
    player: hx(0x1000 + p.id), roundKey: hx(0x2000 + p.id), stakeMsat: p.stake, payoutMsat: p.pay, outcome: 'DELIVERED', score: p.score, name: null })) });
  // the attacker: 20 fresh identities, each in a free round (stake 0, payout 0)
  for (let i = 0; i < 20; i++) {
    rounds.push({ roundId: hx(100 + i), gameId: GAME, startMs: FROM + 100n + BigInt(i), entries: [
      { player: hx(0x9000 + i), roundKey: hx(0x8000 + i), stakeMsat: 0n, payoutMsat: 0n, outcome: 'DELIVERED', score: 1, name: null }] });
  }
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 3, amountMsat: 3_000_000n });
  assert.equal(w.ok, true, w.why);
  const sybils = new Set(Array.from({ length: 20 }, (_, i) => hx(0x9000 + i)));
  const toSybils = w.winners.filter((x) => sybils.has(x.player)).reduce((t, x) => t + BigInt(x.msat), 0n);
  assert.equal(toSybils, 0n, `${toSybils} of 3000000 msat of the reserves' payout went to ${w.winners.filter((x) => sybils.has(x.player)).length} identities that staked nothing`);
});
