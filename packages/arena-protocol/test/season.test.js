// A SEASON: ONE GAME'S FINAL ROUNDS OVER A WINDOW, PER PLAYER (kanban #362 feature 1). The same law as the round's board
// (leaderboard.test.js): presentation, not authority - it adds up amounts the settlements signed and computes none - and
// every node handed the same rounds, in any order, shows the same rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { season, seasonWindow, SEASON_UNCHECKED, DAY_MS, SEASON_DAYS_MAX, mergeSeasonAccounts, SEASON_NETWORK_AGREE,
  seasonRoundsToJson, seasonRoundsFromJson } from '../src/season.js';
import { DELIVERED, FAILED, FORFEIT, VOID, ENTRY_VOID } from '../src/payout.js';

const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a), OTHER = h(0x9b);
const A = h(0x0a), B = h(0x0b), C = h(0x0c), D = h(0x0d);
const T0 = Date.UTC(2026, 9, 10);
const win = { games: [GAME], fromMs: T0, toMs: T0 + 7 * DAY_MS };
const S = 100000n;
const e = (player, outcome, score, payoutMsat, stakeMsat = S, name) => ({ player, outcome, score, payoutMsat, stakeMsat, name });
const round = (n, entries, more = {}) => ({ roundId: h(0x10 + n), gameId: GAME, startMs: T0 + n * 3600000, entries, ...more });
const view = (r) => r.rows.map((x) => [x.player.slice(0, 2), x.rounds, x.wins, String(x.netMsat), x.bestScore]);

test('net msat, then wins, then best score, then the player key', () => {
  const s = season([
    // A wins round 1 by rank and payout: 96000 net stake back + 96000 of B's
    round(1, [e(A, DELIVERED, 500, 192000n), e(B, FAILED, 300, 0n)]),
    // round 2: C and D both net 0 (free), C the sole top score
    round(2, [e(C, DELIVERED, 900, 0n, 0n), e(D, DELIVERED, 100, 0n, 0n)]),
  ], win);
  assert.equal(s.ok, true);
  assert.deepEqual(view(s), [
    ['0a', 1, 1, '92000', 500],
    ['0c', 1, 1, '0', 900],     // net 0 and a win (sole top score) above D
    ['0d', 1, 0, '0', 100],
    ['0b', 1, 0, '-100000', 300],
  ]);
  assert.deepEqual(s.rows.map((r) => r.rank), [1, 2, 3, 4]);
  assert.equal(s.rounds, 2);
  assert.deepEqual(s.unchecked, SEASON_UNCHECKED);
});

test('ties: wins break equal nets, best score breaks equal wins, the key breaks the rest - never arrival order', () => {
  const rounds = [
    round(1, [e(B, DELIVERED, 50, 0n, 0n), e(C, DELIVERED, 40, 0n, 0n)]),     // B wins (sole top)
    round(2, [e(D, DELIVERED, 70, 0n, 0n), e(C, DELIVERED, 70, 0n, 0n)]),     // a shared top: no win for either
    round(3, [e(A, FAILED, 70, 0n, 0n)]),                                     // A: no win, best 70, did not deliver
  ];
  const s = season(rounds, win);
  assert.deepEqual(view(s), [
    ['0b', 1, 1, '0', 50],      // the one win
    ['0a', 1, 0, '0', 70],      // A, C and D tie on net, wins and best score: the key decides
    ['0c', 2, 0, '0', 70],
    ['0d', 1, 0, '0', 70],
  ]);
  // every permutation of the input gives the same rows, and the same list of what was left out
  const perms = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]];
  for (const p of perms) {
    const t = season(p.map((i) => ({ ...rounds[i], entries: [...rounds[i].entries].reverse() })), win);
    assert.deepEqual(t.rows, s.rows, String(p));
    assert.deepEqual(t.excluded, s.excluded, String(p));
  }
});

test('a null best score sorts below any score; a head-to-head draw is no win, a market pick paid above its stake is', () => {
  const s = season([
    round(1, [e(A, null, null, 150000n), e(B, null, null, 0n)]),                       // a market: A's pick paid
    round(2, [e(C, DELIVERED, 2, S - 4000n), e(D, DELIVERED, 2, S - 4000n)]),           // a draw: stakes back less costs
  ], win);
  assert.deepEqual(view(s), [
    ['0a', 1, 1, '50000', null],
    ['0c', 1, 0, '-4000', 2],
    ['0d', 1, 0, '-4000', 2],
    ['0b', 1, 0, '-100000', null],
  ]);
});

test('the window: from inclusive, to exclusive; another game\'s rounds are not this season\'s', () => {
  const s = season([
    { ...round(0, [e(A, DELIVERED, 1, 0n, 0n)]), startMs: T0 },                        // the first ms: in
    { ...round(1, [e(B, DELIVERED, 1, 0n, 0n)]), startMs: T0 - 1 },                    // before: out
    { ...round(2, [e(C, DELIVERED, 1, 0n, 0n)]), startMs: T0 + 7 * DAY_MS },           // the end: out
    { ...round(3, [e(D, DELIVERED, 1, 0n, 0n)]), gameId: OTHER },
    { ...round(4, [e(A, DELIVERED, 3, 0n, 0n)]), startMs: BigInt(T0 + 5) },            // a contract's BigInt time
  ], win);
  assert.deepEqual(view(s), [['0a', 2, 2, '0', 3]]);
  assert.equal(s.rows[0].lastPlayedMs, T0 + 5);
  assert.deepEqual(s.excluded.map((x) => x.why).sort(), [
    'that round is of another game', 'that round started outside the season\'s window', 'that round started outside the season\'s window']);
  assert.equal(s.rounds, 2);
  // a game's versions are several ids: both count when both are named
  assert.equal(season([round(1, [e(A, DELIVERED, 1, 0n, 0n)], { gameId: OTHER })], { ...win, games: [GAME, OTHER] }).rows.length, 1);
});

test('refunds and VOID rounds are no rounds played; an entry with no signed amount is left out, not guessed', () => {
  const s = season([
    round(1, [e(A, VOID, 0, S), e(B, VOID, 0, S)], { void: true }),
    round(2, [e(A, ENTRY_VOID, 0, S), e(B, DELIVERED, 10, S - 4000n)]),
    round(3, [e(A, DELIVERED, 99, null), e(C, FORFEIT, 0, null)]),        // its settlement not held here yet
    round(4, [e(D, VOID, 0, S)]),                                           // every entry refunded: no round at all
  ], win);
  assert.deepEqual(view(s), [['0b', 1, 1, '-4000', 10]], 'B alone is placed: the sole delivered score is rank 1');
  assert.equal(s.rounds, 1);
  const whys = s.excluded.map((x) => `${x.round.slice(0, 2)}${x.player ? `:${x.player.slice(0, 2)}` : ''} ${x.why}`);
  assert.ok(whys.includes('11 a VOID round refunds every stake: it is no round played'));
  assert.ok(whys.includes('12:0a a ENTRY_VOID entry is refunded: it is no round played'));
  assert.ok(whys.includes('13:0a no settlement of that entry is held: its amount is not signed yet'));
  assert.ok(whys.includes('14 no entry of that round is settled and unrefunded'));
  // a FORFEIT is a place, as on the round's board: it played and lost
  assert.deepEqual(view(season([round(1, [e(A, FORFEIT, 0, 0n), e(B, DELIVERED, 5, 196000n)])], win)),
    [['0b', 1, 1, '96000', 5], ['0a', 1, 0, '-100000', 0]]);
});

test('no payout is computed: the amounts handed in are summed as they are, whatever rule they came from', () => {
  // amounts no rank curve or pari-mutuel table would give - the season does not check them against one, and does not mend them
  const s = season([round(1, [e(A, DELIVERED, 1, 123457n), e(B, DELIVERED, 900, 1n)])], win);
  assert.deepEqual(s.rows.map((r) => [r.player.slice(0, 2), String(r.paidMsat), String(r.stakedMsat), String(r.netMsat), r.wins]),
    [['0a', '123457', '100000', '23457', 1], ['0b', '1', '100000', '-99999', 1]]);   // B: rank 1 though paid 1 msat
  const src = readFileSync(new URL('../src/season.js', import.meta.url), 'utf8');
  const imports = (src.match(/^import\s[^;]*;/gm) || []).join('\n');
  assert.match(imports, /from '\.\/payout\.js'/, 'the import statements were found');
  for (const f of ['computePayoutTable', 'pariMutuelTable', 'nodeFeeTable', 'lockSettlement', 'attested.js', 'lock-settlement.js', 'fee.js'])
    assert.ok(!imports.includes(f), `season.js imports no ${f}`);
  // and an amount that is not BigInt msat is refused, not rounded
  assert.equal(season([round(1, [e(A, DELIVERED, 1, 1.5)])], win).rows.length, 0);
  assert.match(season([round(1, [e(A, DELIVERED, 1, 1.5)])], win).excluded[0].why, /BigInt msat/);
});

test('one player with several entries in one round is one round played; a repeat counts once, a contradiction not at all', () => {
  const r1 = round(1, [e(A, FAILED, 10, 0n), e(A, DELIVERED, 40, 196000n), e(B, FAILED, 5, 0n)]);
  const s = season([r1, r1], win);
  assert.deepEqual(view(s), [['0a', 1, 1, '-4000', 40], ['0b', 1, 0, '-100000', 5]]);
  assert.ok(s.excluded.some((x) => /counted once/.test(x.why)));
  const other = { ...r1, entries: [e(A, FAILED, 10, 0n), e(B, DELIVERED, 40, 196000n)] };
  const t = season([r1, other], win);
  assert.deepEqual(t.rows, []);
  assert.ok(t.excluded.some((x) => /two different accounts/.test(x.why)));
  assert.deepEqual(season([other, r1], win).rows, [], 'whichever came first');
});

test('the name is the one of the player\'s latest round', () => {
  const s = season([
    round(2, [e(A, DELIVERED, 1, 0n, 0n, 'newer')]),
    round(1, [e(A, DELIVERED, 1, 0n, 0n, 'older')]),
    round(3, [e(A, DELIVERED, 1, 0n, 0n)]),               // no record: the latest NAMED round's name stands
    round(4, [e(B, DELIVERED, 1, 0n, 0n)]),
  ], win);
  assert.deepEqual(s.rows.map((r) => [r.player.slice(0, 2), r.name]), [['0a', 'newer'], ['0b', null]]);
});

test('the window a door asks: 1 to 90 whole days, a week by default, refused by name otherwise', () => {
  assert.deepEqual(seasonWindow({ nowMs: T0 }), { ok: true, days: 7, fromMs: T0 - 7 * DAY_MS, toMs: T0 });
  assert.deepEqual(seasonWindow({ nowMs: T0, days: '90' }), { ok: true, days: 90, fromMs: T0 - 90 * DAY_MS, toMs: T0 });
  assert.equal(seasonWindow({ nowMs: T0, days: 1 }).fromMs, T0 - DAY_MS);
  for (const days of [0, 91, 1.5, -3, 'x', '', 'NaN', null])
    assert.equal(seasonWindow({ nowMs: T0, days }).ok, false, String(days));
  assert.equal(SEASON_DAYS_MAX, 90);
  assert.equal(season([], { games: [], fromMs: 0, toMs: 1 }).ok, false, 'a season is of a game');
  assert.equal(season([], { games: [GAME], fromMs: 5, toMs: 5 }).ok, false, 'an empty window');
  assert.deepEqual(season([], win).rows, []);
});

// THE NETWORK SEASON'S MERGE (scope=network): a round from other seats counts only when SEASON_NETWORK_AGREE (3) distinct
// seats handed in byte-identical accounts of it - an honest FINAL round sits in >= 5 committee seats' stores, a forged
// one takes 3 colluding seats.
const ids = (m) => m.rounds.map((r) => r.roundId.slice(0, 2));
const whys = (m) => m.excluded.map((x) => [x.round ? x.round.slice(0, 2) : null, x.seat || null, x.why]);

test('merge: a round three seats agree on counts; one two seats hand in does not', () => {
  assert.equal(SEASON_NETWORK_AGREE, 3);
  const r1 = round(1, [e(A, DELIVERED, 500, 192000n), e(B, FAILED, 300, 0n)]);
  const r2 = round(2, [e(C, DELIVERED, 900, 0n, 0n)]);
  const m = mergeSeasonAccounts(new Map([['s1', [r1, r2]], ['s2', [r1, r2]], ['s3', [r1]]]));
  assert.equal(m.ok, true);
  assert.deepEqual(ids(m), ['11']);
  assert.deepEqual(whys(m), [['12', null, 'that round is held by fewer than 3 seats with one account of it']]);
  // and season() on the agreed rounds is the season of those rounds as one seat would build it
  assert.deepEqual(season(m.rounds, win).rows, season([r1], win).rows);
  // a plain object is a map of seats too; the threshold is the caller's to lower (a test net of two seats)
  assert.deepEqual(ids(mergeSeasonAccounts({ s1: [r2], s2: [r2] }, { agree: 2 })), ['12']);
  assert.equal(mergeSeasonAccounts(null).ok, false);
  assert.equal(mergeSeasonAccounts(new Map(), { agree: 0 }).ok, false);
});

test('merge: one seat that disagrees does not strike a round three others agree on; a tie at the top does', () => {
  const r1 = round(1, [e(A, DELIVERED, 500, 192000n), e(B, FAILED, 300, 0n)]);
  const late = round(1, [e(A, DELIVERED, 500, null), e(B, FAILED, 300, null)]);     // a seat not ACCEPTED yet: no amounts
  const forged = round(1, [e(A, DELIVERED, 500, 1n), e(B, FAILED, 300, 191999n)]);
  // DECIDED: the account held by the most seats counts once it reaches 3 - a lagging or lying seat cannot take a round
  // off the board alone (else any one seat could empty it of every round it holds)
  const m = mergeSeasonAccounts(new Map([['s1', [r1]], ['s2', [r1]], ['s3', [r1]], ['s4', [forged]]]));
  assert.deepEqual(ids(m), ['11']);
  assert.deepEqual(season(m.rounds, win).rows, season([r1], win).rows, 'the three seats\' account, not the fourth\'s');
  assert.deepEqual(m.excluded, []);
  // two seats against three: still the three; the late seats' version wins only where it is held by more
  assert.deepEqual(season(mergeSeasonAccounts({ a: [r1], b: [r1], c: [r1], d: [late], e: [late] }).rounds, win).rows, season([r1], win).rows);
  assert.equal(season(mergeSeasonAccounts({ a: [r1], b: [r1], c: [r1], d: [late], e: [late], f: [late], g: [late] }).rounds, win).rows.length, 0,
    'four seats short of the settlement against three: the round counts with no amounts held, so no row yet');
  // THREE AGAINST THREE: the seats disagree, and the merge does not choose
  const tie = mergeSeasonAccounts({ a: [r1], b: [r1], c: [r1], d: [forged], e: [forged], f: [forged] });
  assert.deepEqual(ids(tie), []);
  assert.deepEqual(whys(tie), [['11', null, 'the seats disagree on that round: two accounts of it are each held by 3 seats']]);
  // two against two: no account held by three, and they differ
  assert.deepEqual(whys(mergeSeasonAccounts({ a: [r1], b: [r1], d: [forged], e: [forged] })),
    [['11', null, 'the seats disagree on that round, and no account of it is held by 3 seats']]);
});

test('merge: a seat counts once, however often it hands a round in; a seat that contradicts itself backs neither account', () => {
  const r1 = round(1, [e(A, DELIVERED, 500, 192000n), e(B, FAILED, 300, 0n)]);
  const other = round(1, [e(A, FAILED, 500, 0n), e(B, DELIVERED, 300, 192000n)]);
  // the same seat three times over is one seat: two seats in all
  assert.deepEqual(whys(mergeSeasonAccounts({ s1: [r1, r1, r1], s2: [r1] })),
    [['11', null, 'that round is held by fewer than 3 seats with one account of it']]);
  // one seat's two accounts of one round: it backs neither; the other two are short of three
  const m = mergeSeasonAccounts({ s1: [r1, other], s2: [r1], s3: [r1] });
  assert.deepEqual(ids(m), []);
  assert.deepEqual(whys(m).sort(), [
    ['11', null, 'that round is held by fewer than 3 seats with one account of it'],
    ['11', 's1', 'that seat handed in two different accounts of that round: it backs neither'],
  ]);
  // a copy whose entries are listed in another order is the same account
  const reordered = { ...r1, entries: [...r1.entries].reverse() };
  assert.deepEqual(ids(mergeSeasonAccounts({ s1: [r1], s2: [reordered], s3: [r1] })), ['11']);
  // a malformed round is no account, and is named with the seat that handed it in
  assert.deepEqual(whys(mergeSeasonAccounts({ s1: [{ ...r1, gameId: 'x' }] })), [['11', 's1', 'that round names no game id']]);
});

test('merge: the order of the seats, of their rounds and of each round\'s entries decides nothing', () => {
  const r1 = round(1, [e(A, DELIVERED, 500, 192000n), e(B, FAILED, 300, 0n)]);
  const r2 = round(2, [e(C, DELIVERED, 900, 0n, 0n), e(D, DELIVERED, 100, 0n, 0n)]);
  const r3 = round(3, [e(D, DELIVERED, 70, 0n, 0n)]);
  const f1 = round(1, [e(A, DELIVERED, 500, 1n), e(B, FAILED, 300, 191999n)]);
  const seats = [['s1', [r1, r2, r3]], ['s2', [r2, r1]], ['s3', [r1, r2, r3]], ['s4', [f1, r3]], ['s5', [r1, r1]]];
  const m = mergeSeasonAccounts(new Map(seats));
  assert.deepEqual(ids(m), ['11', '12', '13']);
  const perms = [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 3, 0, 4, 2]];
  for (const p of perms) {
    const t = mergeSeasonAccounts(new Map(p.map((i) => [seats[i][0], [...seats[i][1]].reverse().map((r) => ({ ...r, entries: [...r.entries].reverse() }))])));
    assert.deepEqual(t, m, String(p));
    assert.deepEqual(season(t.rounds, win), season(m.rounds, win), String(p));
  }
});

test('a season\'s rounds on the wire: every msat a decimal string and back, a value that is not one refused, not mended', () => {
  const r1 = round(1, [e(A, DELIVERED, 500, 192000n, S, 'alice'), e(B, null, null, null)]);
  const wire = JSON.parse(JSON.stringify(seasonRoundsToJson([r1])));
  assert.deepEqual(wire[0].entries.map((x) => [x.stakeMsat, x.payoutMsat, x.name]), [['100000', '192000', 'alice'], ['100000', null, null]]);
  assert.equal(wire[0].startMs, String(r1.startMs));
  const back = seasonRoundsFromJson(wire);
  assert.equal(back[0].startMs, BigInt(r1.startMs));
  // the round that came over the wire is the same account as the one handed in here: three seats, one of them local
  assert.deepEqual(ids(mergeSeasonAccounts({ here: [r1], a: back, b: seasonRoundsFromJson(wire) })), ['11']);
  // a float or a number where a decimal string belongs is handed on as it came, for the season to refuse by name
  const bad = seasonRoundsFromJson([{ ...wire[0], entries: [{ ...wire[0].entries[0], payoutMsat: 1.5 }] }]);
  assert.match(season(bad, win).excluded[0].why, /BigInt msat/);
  assert.deepEqual(seasonRoundsFromJson('x'), []);
});
