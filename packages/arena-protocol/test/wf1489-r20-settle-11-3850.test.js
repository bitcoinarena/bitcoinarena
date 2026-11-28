// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r20 settle 11 / kanban #3850 (RULED 2026-11-28, amends #2841's rule 5): a closed ring of four identities of one attacker that only ever
// play each other ages itself, and in the week A beats B, C and D - three older opponents, a positive P&L, a cap of 10x its fees. From the named week
// window on, a place pays at most the fees paid in its counted rounds (own + older opponents'), never more than 10x own fees; a window that started
// before keeps the 10 x cap alone; the weekly badge keeps rules 1-4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboardWinners } from '../src/leaderboard-winners.js';
import { placeStanding, capsAtCountedFees, PLACE_COUNTED_FEES_FROM_MS } from '../src/place-eligibility.js';

const hx = (n) => n.toString(16).padStart(64, '0');
const GAME = 'aa'.repeat(32);
const DAY = 86400000n;
const S = 1_000_000n;            // 1,000 sat stake per entry
let rid = 1;
const P = (n) => hx(0x1000 + n), K = (n) => hx(0x5000 + n);
const h2h = (at, win, lose) => ({ roundId: hx(rid++), gameId: GAME, startMs: at, entries: [
  { player: P(win), roundKey: K(win), stakeMsat: S, payoutMsat: 1_800_000n, outcome: 'DELIVERED', score: 2, name: null },
  { player: P(lose), roundKey: K(lose), stakeMsat: S, payoutMsat: 0n, outcome: 'FAILED', score: 0, name: null }] });
const FROM = 100n * DAY, TO = FROM + 7n * DAY;
const ring = () => {
  const rounds = [h2h(FROM - 3n * DAY, 2, 1), h2h(FROM - 3n * DAY + 1n, 3, 4)];
  for (const o of [2, 3, 4]) rounds.push(h2h(FROM + 1000n + BigInt(o), 1, o));
  return rounds;
};
const paidOf = (w) => w.winners.reduce((t, x) => t + x.msat, 0n);

test('r20-settle-11 / #3850 from the named window: the ring\'s place is capped at the ring\'s fees in the counted rounds', () => {
  const rounds = ring();
  const ringFees = BigInt(rounds.length * 2) * S / 10n;     // every entry of the ring, both weeks, 10 % fee: 1,000,000 msat
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 1, amountMsat: 10_000_000n, countedFeesFromMs: FROM });
  assert.equal(w.ok, true, w.why);
  const before = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 1, amountMsat: 10_000_000n });
  console.log(`  FACTS (#3850): ring fees ${ringFees}; place paid ${paidOf(w)} (counted-fees cap), ${paidOf(before)} under the 10 x cap alone`);
  assert.equal(paidOf(w), 600_000n, 'A and its three opponents paid 6 x 100,000 msat in the three counted rounds');
  assert.ok(paidOf(w) <= ringFees);
  assert.equal(paidOf(before), 3_000_000n, 'a window before the named start: 10 x own fees, as before');
});

test('#3850 an honest head-to-head winner is capped at own + opponents\' fees; a round with a fresh opponent adds neither P&L nor cap', () => {
  const rounds = [];
  // four honest players, all older than the week (each played someone outside the week)
  for (const o of [2, 3, 4]) rounds.push(h2h(FROM - 5n * DAY + BigInt(o), o, 9));
  rounds.push(h2h(FROM - 5n * DAY, 1, 9));
  for (const o of [2, 3, 4]) rounds.push(h2h(FROM + 2000n + BigInt(o), 1, o));
  // and a win over a fresh identity 7 (first paid inside the week): no P&L, no cap
  rounds.push(h2h(FROM + 3000n, 1, 7));
  const st = placeStanding({ rounds, games: [GAME], fromMs: FROM, toMs: TO, countedFeesCap: true }).get(P(1));
  assert.equal(st.eligible, true, st.why);
  assert.equal(st.countedFeesMsat, 600_000n, 'own 100,000 + opponent 100,000 in each of the three counted rounds');
  assert.equal(st.feesMsat, 400_000n, 'own fees in the window, the fresh round included');
  assert.equal(st.capMsat, 600_000n, 'min(10 x 400,000, 600,000)');
  const old = placeStanding({ rounds, games: [GAME], fromMs: FROM, toMs: TO }).get(P(1));
  assert.equal(old.capMsat, 4_000_000n, 'without the rule: 10 x own fees');
});

test('#3850 the named start: by window, per network; none is named yet', () => {
  assert.equal(PLACE_COUNTED_FEES_FROM_MS.testnet4, null);
  assert.equal(capsAtCountedFees({ network: 'testnet4', fromMs: FROM }), false, 'not named: the 10 x cap alone');
  assert.equal(capsAtCountedFees({ fromMs: FROM, startMs: FROM }), true);
  assert.equal(capsAtCountedFees({ fromMs: FROM - 1n, startMs: FROM }), false, 'a window that started before the named start');
});

test('#3850 every seat derives the same winners list from the same rounds', () => {
  const a = leaderboardWinners({ rounds: ring(), games: [GAME], fromMs: FROM, toMs: TO, top: 2, amountMsat: 10_000_000n, countedFeesFromMs: FROM });
  rid = 1;
  const b = leaderboardWinners({ rounds: [...ring()].reverse(), games: [GAME], fromMs: FROM, toMs: TO, top: 2, amountMsat: 10_000_000n, countedFeesFromMs: FROM });
  assert.deepEqual(a.winners.map((x) => [x.player, String(x.msat)]), b.winners.map((x) => [x.player, String(x.msat)]));
});
