// ACHIEVEMENTS AND BADGES (kanban #362, PLATFORM-RESEARCH item 13): who earned which badge, read through season() - a round
// played and won exactly as the season board says - for an identity only, never a bare round key, with the earliest rounds
// that earned it as evidence, and the same awards from the same rounds in any order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGES, BADGES_VERSION, badgesEarned, checkCatalogue, lastClosedWeek, WEEK_MS, WEEK_ZERO_MS, PERFECT_RUN_SCORE } from '../src/badges.js';
import { DELIVERED, FAILED, VOID } from '../src/payout.js';

const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a), OTHER = h(0x9b);
const NB = { name: 'nextblock', ids: [GAME] };
// THE IDENTITIES, and the fresh round key each joins under in each round
const A = h(0x0a), B = h(0x0b), C = h(0x0c), D = h(0x0d);
let keys = 0x40;
const rk = () => h(keys++);
const S = 100000n;
const T0 = Date.UTC(2026, 9, 5);                 // a Monday
/** An entry: the identity, the outcome and score, what the settlement paid it back, its stake, and its round key. */
const e = (player, outcome, score, payoutMsat, { stakeMsat = S, roundKey = rk() } = {}) => ({ player, roundKey, outcome, score, payoutMsat, stakeMsat, name: null });
const round = (n, entries, more = {}) => ({ roundId: h(0x10 + n), gameId: GAME, startMs: BigInt(T0 + n * 3600000), entries, ...more });
const view = (awards) => awards.map((a) => [a.d, a.player.slice(0, 2), a.scope, a.evidence.rounds ? a.evidence.rounds.map((r) => r.slice(0, 2)) : a.evidence]);
const shuffled = (xs) => [...xs].map((x, i) => [((i * 7919) % 13), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);

test('the catalogue: fixed, frozen, versioned; every d well formed and once; a broken catalogue is refused by name', () => {
  assert.equal(BADGES_VERSION, 1);
  assert.deepEqual(BADGES.map((b) => [b.d, b.rule]), [['arena-first-win', 'first-win'], ['arena-five-rounds', 'rounds-played'],
    ['arena-perfect-run', 'delivered-score'], ['arena-season-top-3', 'season-top']]);
  assert.ok(Object.isFrozen(BADGES) && BADGES.every((b) => Object.isFrozen(b)));
  assert.deepEqual(checkCatalogue(BADGES), { ok: true });
  for (const b of BADGES) {
    assert.ok(!b.d.includes(':'), 'no colon: an a tag 30009:<pubkey>:<d> splits whole');
    assert.match(b.image, /^\/badge-image\/[a-z0-9-]+\.svg$/);
    assert.ok(b.name && b.description);
  }
  assert.equal(BADGES[2].minScore, PERFECT_RUN_SCORE);
  assert.equal(PERFECT_RUN_SCORE, 1000 * 100000, '1000 points in the core\'s 1e-5 units');
  assert.match(checkCatalogue([BADGES[0], BADGES[0]]).why, /share the d/);
  assert.match(checkCatalogue([{ ...BADGES[0], d: 'a:b' }]).why, /d is lowercase/);
  assert.match(checkCatalogue([{ ...BADGES[0], rule: 'luck' }]).why, /no known rule/);
  assert.match(checkCatalogue([{ ...BADGES[1], rounds: 0 }]).why, /whole number of rounds/);
  assert.match(badgesEarned({ game: NB, rounds: [] }, [BADGES[0], BADGES[0]]).why, /share the d/);
  assert.match(badgesEarned({ game: { name: 'x', ids: ['zz'] }, rounds: [] }).why, /ids in hex/);
  assert.deepEqual(badgesEarned({ game: NB, rounds: [] }), { ok: true, awards: [] });
});

test('first win: the earliest staked round the season counts as won; a free win, a lost round and another game\'s earn nothing', () => {
  const rounds = [
    round(1, [e(A, FAILED, 100, 0n), e(B, DELIVERED, 900, 192000n)]),            // B wins by rank and payout
    round(2, [e(A, DELIVERED, 800, 192000n), e(B, FAILED, 50, 0n)]),             // A's first win
    round(3, [e(A, DELIVERED, 900, 192000n), e(C, FAILED, 10, 0n)]),             // A again: the evidence stays round 2
    round(4, [e(C, DELIVERED, 999, 0n, { stakeMsat: 0n }), e(D, DELIVERED, 5, 0n, { stakeMsat: 0n })]),   // free: C's win is no badge
    round(5, [e(D, DELIVERED, 700, 192000n)], { gameId: OTHER }),                // another game's round
  ];
  const got = badgesEarned({ game: NB, rounds }, [BADGES[0]]);
  assert.equal(got.ok, true);
  assert.deepEqual(view(got.awards), [
    ['arena-first-win', '0a', 'nextblock', ['12']],
    ['arena-first-win', '0b', 'nextblock', ['11']],
  ]);
  // A WIN BY PAYOUT (a market's right pick: no score, paid more than staked) is a win as the season counts it
  const pick = badgesEarned({ game: NB, rounds: [round(6, [e(D, null, null, 150000n), e(C, null, null, 0n)])] }, [BADGES[0]]);
  assert.deepEqual(view(pick.awards), [['arena-first-win', '0d', 'nextblock', ['16']]]);
  // the same rounds in any order, and handed in twice, are the same awards
  assert.deepEqual(badgesEarned({ game: NB, rounds: shuffled([...rounds, ...rounds]) }, [BADGES[0]]), got);
  // the earliest by START, not by id: a round with a lower id that started later is not the first win
  const late = round(0, [e(A, DELIVERED, 999, 192000n), e(B, FAILED, 1, 0n)], { startMs: BigInt(T0 + 99 * 3600000) });
  assert.deepEqual(view(badgesEarned({ game: NB, rounds: [late, ...rounds] }, [BADGES[0]]).awards).find((x) => x[1] === '0a')[3], ['12']);
});

test('five rounds: the first five staked rounds the season counts; a VOID round, an unsettled or refunded entry are no round played', () => {
  const r = (n, more) => round(n, [e(A, n % 2 ? DELIVERED : FAILED, n, n % 2 ? 192000n : 0n), e(B, FAILED, 0, 0n)], more);
  const four = [r(1), r(2), r(3), r(4), r(5, { void: true }),
    round(6, [e(A, DELIVERED, 5, null)]),                                        // its settlement not held: no amount, no round
    round(7, [e(A, VOID, 0, S)])];                                               // a refunded entry
  assert.deepEqual(badgesEarned({ game: NB, rounds: four }, [BADGES[1]]).awards, [], 'four rounds played');
  const six = [...four, r(9), r(8)];
  assert.deepEqual(view(badgesEarned({ game: NB, rounds: six }, [BADGES[1]]).awards), [
    ['arena-five-rounds', '0a', 'nextblock', ['11', '12', '13', '14', '18']],
    ['arena-five-rounds', '0b', 'nextblock', ['11', '12', '13', '14', '18']],     // B lost them all: played is played
  ], 'the first five by start: 1, 2, 3, 4, 8 - not 9');
  // ONE ROUND, TWO ACCOUNTS: the season counts neither, and neither does a badge
  const conflict = [...four, r(8), { ...r(8), entries: [e(A, DELIVERED, 8, 1n), e(B, FAILED, 0, 0n)] }];
  assert.deepEqual(badgesEarned({ game: NB, rounds: conflict }, [BADGES[1]]).awards, []);
});

test('perfect run: a staked DELIVERED nextblock run at 1000 points or more; one under it, a failed one, another game\'s earn nothing', () => {
  const rounds = [
    round(1, [e(A, DELIVERED, PERFECT_RUN_SCORE - 1, 192000n), e(B, FAILED, PERFECT_RUN_SCORE * 2, 0n)]),
    round(2, [e(C, DELIVERED, PERFECT_RUN_SCORE, 100000n)]),
    round(3, [e(D, DELIVERED, PERFECT_RUN_SCORE * 1.5, 0n, { stakeMsat: 0n })]),  // free
  ];
  assert.deepEqual(view(badgesEarned({ game: NB, rounds }, [BADGES[2]]).awards), [['arena-perfect-run', '0c', 'nextblock', ['12']]]);
  assert.deepEqual(badgesEarned({ game: { name: 'rock-paper-scissors', ids: [GAME] }, rounds }, [BADGES[2]]).awards, [],
    'the perfect run is Tick Tock\'s alone: another game\'s score is on another scale');
});

test('no badge to a bare round key: an entry whose player is its own round key, or that names none, earns nothing', () => {
  const bare = (n) => round(n, [e(A, DELIVERED, PERFECT_RUN_SCORE, 192000n, { roundKey: A }), { ...e(B, DELIVERED, PERFECT_RUN_SCORE, 0n), roundKey: undefined }]);
  const rounds = [1, 2, 3, 4, 5].map(bare);
  assert.deepEqual(badgesEarned({ game: NB, rounds }).awards, []);
  // the same rounds under identities earn all three round badges
  const named = [1, 2, 3, 4, 5].map((n) => round(n, [e(A, DELIVERED, PERFECT_RUN_SCORE, 192000n), e(B, FAILED, 0, 0n)]));
  assert.deepEqual(badgesEarned({ game: NB, rounds: named }).awards.filter((a) => a.player === A).map((a) => a.d),
    ['arena-first-win', 'arena-five-rounds', 'arena-perfect-run']);
});

test('season top 3: the last whole UTC week closed (Monday to Monday), its board as season() ranks it, rank 1-3 of at least 3 players', () => {
  // THE WEEK: aligned to Mondays 00:00 UTC, the same on every seat whatever its clock reads inside the next week
  assert.equal(new Date(WEEK_ZERO_MS).getUTCDay(), 1);
  const thu = Date.UTC(2026, 9, 15, 12);
  assert.deepEqual(lastClosedWeek(thu), { fromMs: T0, toMs: T0 + WEEK_MS });
  assert.deepEqual(lastClosedWeek(T0 + WEEK_MS), { fromMs: T0, toMs: T0 + WEEK_MS }, 'closed at its last instant');
  assert.deepEqual(lastClosedWeek(T0 + WEEK_MS - 1), { fromMs: T0 - WEEK_MS, toMs: T0 }, 'one ms earlier it is still open');
  assert.equal(lastClosedWeek(0), null);
  const board = [
    round(1, [e(A, DELIVERED, 500, 300000n), e(B, FAILED, 1, 0n), e(C, FAILED, 2, 0n)]),     // A +200000
    round(2, [e(D, DELIVERED, 400, 150000n), e(B, FAILED, 3, 0n)]),                           // D +50000
    round(3, [e(C, DELIVERED, 900, 0n, { stakeMsat: 0n })]),                                  // free: counts on the board
    round(200, [e(B, DELIVERED, 999, 900000n)]),                                              // next week: not this board
  ];
  const got = badgesEarned({ game: NB, rounds: board, nowMs: thu }, [BADGES[3]]);
  assert.deepEqual(got.awards.map((a) => [a.player.slice(0, 2), a.scope, a.evidence]), [
    ['0a', 'nextblock@2026-10-05', { window: { fromMs: T0, toMs: T0 + WEEK_MS }, rank: 1 }],
    ['0c', 'nextblock@2026-10-05', { window: { fromMs: T0, toMs: T0 + WEEK_MS }, rank: 3 }],
    ['0d', 'nextblock@2026-10-05', { window: { fromMs: T0, toMs: T0 + WEEK_MS }, rank: 2 }],
  ], 'by net: A +200000, D +50000, C -100000 (its free round adds 0), B -200000 fourth');
  // no clock handed in: no board badge looked for
  assert.deepEqual(badgesEarned({ game: NB, rounds: board }, [BADGES[3]]).awards, []);
  // a board of two players hands no podium
  assert.deepEqual(badgesEarned({ game: NB, rounds: [board[1]], nowMs: thu }, [BADGES[3]]).awards, []);
  // a key that played the week as its own round key is no identity on the board: its place is not given to the fourth
  const withBare = [round(1, [e(A, DELIVERED, 500, 300000n, { roundKey: A }), e(B, FAILED, 1, 0n), e(C, FAILED, 2, 0n)]), ...board.slice(1)];
  const nb = badgesEarned({ game: NB, rounds: withBare, nowMs: thu }, [BADGES[3]]);
  assert.ok(!nb.awards.some((a) => a.player === A));
  assert.ok(!nb.awards.some((a) => a.evidence.rank > 3));
  // any order, the same awards
  assert.deepEqual(badgesEarned({ game: NB, rounds: shuffled(board), nowMs: thu }, [BADGES[3]]), got);
});
