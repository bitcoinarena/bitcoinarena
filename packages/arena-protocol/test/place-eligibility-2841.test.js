// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2841 (ruling 2026-11-16): a leaderboard place and the weekly top-3 badge go only to a proven identity older than the week, with at
// least 3 distinct opponents older than the week, ranked by the P&L of its rounds against older opponents only, paid at most 10x its entry fees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboardWinners } from '../src/leaderboard-winners.js';
import { placeStanding, PLACE_MIN_OPPONENTS, PLACE_FEE_CAP_X } from '../src/place-eligibility.js';
import { badgesEarned, BADGES, lastClosedWeek } from '../src/badges.js';

const hx = (n) => n.toString(16).padStart(64, '0');
const GAME = 'aa'.repeat(32);
const DAY = 86400000n;
const S = 100000n;
let rid = 1;
const P = (n) => hx(0x1000 + n), K = (n) => hx(0x5000 + n);
// a head-to-head round: `win` takes both net stakes (90 % of each), `lose` gets nothing
const h2h = (at, win, lose) => ({ roundId: hx(rid++), gameId: GAME, startMs: at, entries: [
  { player: P(win), roundKey: K(win), stakeMsat: S, payoutMsat: 180000n, outcome: 'DELIVERED', score: 2, name: null },
  { player: P(lose), roundKey: K(lose), stakeMsat: S, payoutMsat: 0n, outcome: 'FAILED', score: 0, name: null }] });

function world(FROM) {
  const rounds = [];
  // before the week: honest players 1..6 each play once (they are older than the week); socks 20-23 never did
  for (let i = 1; i <= 6; i++) rounds.push(h2h(FROM - 3n * DAY + BigInt(i), i, i === 6 ? 1 : i + 1));
  // the week: player 1 beats 2, 3, 4, 5 (4 older opponents); player 2 beats 3 only; socks play each other in a ring of four
  for (const o of [2, 3, 4, 5]) rounds.push(h2h(FROM + 1000n + BigInt(o), 1, o));
  rounds.push(h2h(FROM + 2000n, 2, 3));
  for (const [a, b] of [[20, 21], [21, 22], [22, 23], [23, 20], [20, 22]]) rounds.push(h2h(FROM + 3000n + BigInt(a * 10 + b), a, b));
  return rounds;
}

test('#2841: fresh sock identities and a player with too few older opponents take no place; the place is capped at 10x the week\'s fees', () => {
  const FROM = 100n * DAY, TO = FROM + 7n * DAY;
  const rounds = world(FROM);
  const st = placeStanding({ rounds, games: [GAME], fromMs: FROM, toMs: TO });
  assert.equal(st.get(P(1)).eligible, true);
  assert.equal(st.get(P(1)).opponents, 4);
  assert.match(st.get(P(2)).why, /2 distinct opponent/, 'player 2 met players 1 and 3 only');
  assert.match(st.get(P(20)).why, /newer than the week/, 'a sock that never played before the week');
  assert.equal(PLACE_MIN_OPPONENTS, 3); assert.equal(PLACE_FEE_CAP_X, 10n);
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 3, amountMsat: 3_000_000n });
  assert.equal(w.ok, true, w.why);
  assert.deepEqual(w.winners.map((x) => x.player), [P(1)], 'only player 1 places');
  // player 1 paid 4 entries in the week: fees 4 x 10 % x 100,000 = 40,000 msat; cap 400,000 of the 1,000,000 place
  assert.equal(w.winners[0].msat, 400000n);
  assert.equal(w.winners[0].cappedFromMsat, '1000000');
  assert.equal(w.totalMsat, 400000n, 'the rest stays in the reserves');
});

test('#2841: wins over identities newer than the week do not raise a place (P&L against older opponents only)', () => {
  const FROM = 100n * DAY, TO = FROM + 7n * DAY;
  const rounds = world(FROM);
  // player 3 farms three fresh socks for a big net, but also plays three older opponents and loses once
  for (const s of [30, 31, 32]) rounds.push(h2h(FROM + 5000n + BigInt(s), 3, s));
  for (const o of [4, 5]) rounds.push(h2h(FROM + 6000n + BigInt(o), 3, o));
  rounds.push(h2h(FROM + 7000n, 6, 3));
  const st = placeStanding({ rounds, games: [GAME], fromMs: FROM, toMs: TO });
  // against older: lost to 1 (-100k), lost to 2 (-100k), beat 4, 5 (+80k each), lost to 6 (-100k) = -140,000; the sock wins (+240,000) do not count
  assert.equal(st.get(P(3)).netMsat, -140000n);
  const w = leaderboardWinners({ rounds, games: [GAME], fromMs: FROM, toMs: TO, top: 3, amountMsat: 3_000_000n });
  assert.ok(!w.winners.some((x) => x.player === P(3)));
});

test('#2841: the weekly top-3 badge follows the same rule', () => {
  const now = 200n * DAY + 3n * 3600000n;
  const week = lastClosedWeek(Number(now));
  const rounds = world(BigInt(week.fromMs));
  const b = badgesEarned({ game: { name: 'rps', ids: [GAME] }, rounds, nowMs: Number(now) }, BADGES.filter((x) => x.rule === 'season-top'));
  assert.equal(b.ok, true, b.why);
  assert.deepEqual([...new Set(b.awards.map((a) => a.player))], [P(1)], 'only player 1 earns the board badge');
});
