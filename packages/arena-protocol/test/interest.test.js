// WHICH TWENTY OTHERS YOU SEE, AND WHY EVERY NODE PICKS THE SAME TWENTY.
//
// IMPLEMENTATION section 7: "Ghost fan-out uses interest management: each
// connection subscribes to ~20 others (nearest plus leaderboard top),
// recomputed every few seconds - O(N.K), never O(N^2)."
//
// The bandwidth half is measured below. The half that matters more is that a
// set a node chooses however it likes is a set the OPERATOR chooses: show a
// player the competitors it wants them to see, hide the one about to beat
// them, and the round looks different depending on which node answered. 0.9
// lets a player watch competitors "drive, struggle, fail and arrive"; it does
// not say "watch whichever ones your node felt like sending".
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import {
  interestSet, fanOut, distanceSquared, GHOST_SUBSCRIPTIONS, LEADER_SHARE,
} from '../src/interest.js';
import { leaderboard } from '../src/leaderboard.js';
import { resultId, RESULTS_FOR_FINAL } from '../src/result.js';
import { roundId } from '../src/contracts.js';
import { DELIVERED, VOID } from '../src/payout.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const COMMITTEE = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xc0 + n));
/**
 * A WHOLE ROUND CONTRACT: the board is of one round, and it computes which
 * round from the contract's own bytes, so a stub carrying only `nodes` has no
 * id to check finals against and refuses to build a board at all.
 */
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: COMMITTEE,
};
const ROUND = roundId(contract);

/**
 * A REAL BOARD, built by `leaderboard` from signed finals - not a hand-written
 * table of ranks. Hand-writing them would test this file against itself: the
 * whole point of the slice is that one ordering is computed the same way
 * everywhere, so the fixture has to come from that ordering.
 *
 * `standings` is [playerKeyByte, score] pairs, best score first or not - the
 * board decides.
 */
const boardOf = (standings, outcome = DELIVERED) => leaderboard(
  standings.map(([p, score]) => {
    const result = {
      roundId: ROUND, playerPubkey: id(p), outcome, score,
      transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: COMMITTEE[0],
    };
    const rid = resultId(result);
    return {
      result,
      signedBy: COMMITTEE.slice(0, RESULTS_FOR_FINAL)
        .map((nodePubkey) => ({ resultId: rid, nodePubkey })),
    };
  }),
  { contract },
);

const id = (n) => { const b = new Uint8Array(32); b[30] = n >> 8; b[31] = n & 255; return b; };
/** A grid of players, rank i, spaced forty metres apart in Q16.16. */
const field = (n) => Array.from({ length: n }, (_, i) => ({
  entryId: id(i), playerPubkey: id(i),
  x: (i % 13) * 65536 * 40, z: Math.floor(i / 13) * 65536 * 40,
}));
/** The board that ranks a whole field, best score to the lowest index. */
const boardFor = (n) => boardOf(Array.from({ length: n }, (_, i) => [i, 100000 - i]));

/**
 * N.K, NOT N^2. Measured, not asserted: below the budget everybody is within
 * it and the two are equal, because there is nobody to leave out - and above
 * it the frames grow with N while everyone-sees-everyone grows with N squared.
 */
test('a broadcast costs N times K frames, not N squared', () => {
  const seen = [];
  for (const n of [2, 20, 40, 60, 120]) seen.push([n, fanOut(field(n))]);

  for (const [n, r] of seen) {
    if (n <= GHOST_SUBSCRIPTIONS + 1) {
      assert.equal(r.frames, r.everyone, `at ${n} there is nobody to leave out`);
      continue;
    }
    assert.equal(r.frames, n * GHOST_SUBSCRIPTIONS, `fan-out at ${n} is not N times K`);
    assert.ok(r.frames < r.everyone, `at ${n} the budget saved nothing`);
  }

  // and it really is linear: doubling N doubles the frames while
  // everyone-sees-everyone roughly quadruples
  const at = (n) => seen.find(([m]) => m === n)[1];
  assert.equal(at(120).frames, 2 * at(60).frames);
  assert.ok(at(120).everyone > 3.5 * at(60).everyone);

  // 60 players: 1200 frames against 3540
  assert.equal(at(60).frames, 1200);
  assert.equal(at(60).everyone, 3540);
});

/**
 * THE SAME TWENTY, WHOEVER IS ASKING AND HOWEVER THE PLAYERS ARRIVED. Two
 * nodes handed the same round must answer alike, or a player's competitors
 * depend on which node they connected to - the fault a census tie on work had
 * before it was broken on the tip hash.
 */
test('the set does not depend on the order the players arrived in', () => {
  const players = field(60);
  const want = interestSet(players[0], players);
  assert.equal(want.length, GHOST_SUBSCRIPTIONS);

  const orders = [
    [...players].reverse(),
    [...players].sort((a, b) => (a.rank % 7) - (b.rank % 7)),
    [...players].sort((a, b) => b.x - a.x || a.z - b.z),
  ];
  for (const order of orders) {
    const got = interestSet(players[0], order);
    assert.deepEqual(got.map((o) => o.entryId[31]), want.map((o) => o.entryId[31]),
      'a different arrival order gave a different set, or a different order');
  }

  // three trucks in the same place: a tie is broken by the entry id, not by
  // position in the array
  const tied = [9, 3, 7].map((n) => ({ entryId: id(n), playerPubkey: id(n), x: 0, z: 0 }));
  const viewer = { entryId: id(0), x: 65536, z: 0 };
  const board = boardOf([[9, 100], [3, 100], [7, 100]]);
  const one = interestSet(viewer, tied, { limit: 2, board }).map((o) => o.entryId[31]);
  const two = interestSet(viewer, [...tied].reverse(), { limit: 2, board })
    .map((o) => o.entryId[31]);
  assert.deepEqual(one, two, 'three players at the same place and rank were ordered by luck');
  assert.deepEqual(one, [3, 7], 'a tie was not broken by the entry id');
});

/**
 * THE LEADERS AND THE NEIGHBOURS, both. Either half alone would be a different
 * game: only leaders and the truck beside you is invisible, only neighbours
 * and you never see who is winning.
 */
test('the budget goes to the leaders and to the nearest, and the viewer is not in it', () => {
  // the viewer sits far from the leaders, so the two halves cannot overlap
  const leaders = Array.from({ length: 10 }, (_, i) => ({
    entryId: id(i), playerPubkey: id(i), x: 0, z: 0,
  }));
  const neighbours = Array.from({ length: 10 }, (_, i) => ({
    entryId: id(100 + i), playerPubkey: id(100 + i),
    x: 900 * 65536 + i * 65536, z: 900 * 65536,
  }));
  const viewer = { entryId: id(200), x: 900 * 65536, z: 900 * 65536 };

  // the board ranks the far ten best and the near ten worst
  const board = boardOf([
    ...leaders.map((_, i) => [i, 100000 - i]),
    ...neighbours.map((_, i) => [100 + i, 500 - i]),
  ]);

  const set = interestSet(viewer, [...leaders, ...neighbours], { limit: 8, board });
  assert.equal(set.length, 8);
  const who = set.map((o) => o.entryId[31] | (o.entryId[30] << 8));
  const taken = { leaders: who.filter((n) => n < 10), near: who.filter((n) => n >= 100) };

  assert.equal(taken.leaders.length, 8 / LEADER_SHARE, 'the leaders half moved');
  assert.equal(taken.near.length, 8 - 8 / LEADER_SHARE);
  assert.deepEqual(taken.leaders.sort((a, b) => a - b), [0, 1, 2, 3],
    'the leaders taken were not the top of the board');

  // the nearest half really is the nearest, not any four
  assert.deepEqual(taken.near.sort((a, b) => a - b), [100, 101, 102, 103]);

  // A PLAYER IS NEVER IN THEIR OWN SET. They are driving that truck.
  const all = field(30);
  for (const v of [all[0], all[15], all[29]])
    assert.equal(interestSet(v, all).some((o) => o.entryId[31] === v.entryId[31]), false,
      'a player was sent a picture of their own truck');
});

/**
 * DISTANCE IS BIGINT, and it has to be. The words are Q16.16 in an i32, so two
 * players far apart square past what a double holds exactly - and a comparison
 * that silently rounded would put the wrong truck in somebody's twenty.
 */
test('distance stays exact where a double would stop being', () => {
  // Two trucks the same enormous distance away in x, one of them a single
  // Q16.16 unit further in z. Exactly, one is nearer. As doubles they are the
  // same number: the squared x is 2^62 and the ULP up there is 1024, so a
  // difference of one is gone before the addition finishes.
  const viewer = { entryId: id(0), x: -0x40000000, z: 0 };
  const a = { entryId: id(1), playerPubkey: id(1), x: 0x40000000, z: 0 };
  const b = { entryId: id(2), playerPubkey: id(2), x: 0x40000000, z: 1 };

  const da = distanceSquared(viewer, a);
  const db = distanceSquared(viewer, b);
  assert.equal(typeof da, 'bigint');
  assert.ok(db > da, 'the further truck did not measure further');
  assert.ok(da > BigInt(Number.MAX_SAFE_INTEGER), 'the fixture is not past a double');
  assert.equal(Number(da) === Number(db), true,
    'as doubles these two are the same number, which is the point');

  assert.deepEqual(interestSet(viewer, [a, b], { limit: 1 }).map((o) => o.entryId[31]), [1],
    'the nearer of two trucks a double cannot tell apart was not chosen');

  // and the order does not rescue it: offered the other way round, still a
  assert.deepEqual(interestSet(viewer, [b, a], { limit: 1 }).map((o) => o.entryId[31]), [1]);
});

/**
 * The edges, answered rather than guessed at.
 */
test('an empty round, a budget of nothing, and a budget bigger than the field', () => {
  const players = field(5);
  assert.deepEqual(interestSet(players[0], []), []);
  assert.deepEqual(interestSet(players[0], players, { limit: 0 }), []);

  const all = interestSet(players[0], players, { limit: 99 });
  assert.equal(all.length, 4, 'a budget bigger than the field sent more than the field');

  assert.throws(() => interestSet(players[0], players, { limit: -1 }), /whole number/);
  assert.throws(() => interestSet(players[0], players, { limit: 1.5 }), /whole number/);

  // one other player is one frame, whatever the budget says
  assert.equal(fanOut(field(2)).frames, 2);
  assert.equal(fanOut(field(1)).frames, 0, 'a lone player was sent a ghost');
});

/**
 * A CALLER CANNOT HAND IN WHO WON.
 *
 * `interestSet` used to read `rank` straight off the object it was given. That
 * is the fault this repository has removed five times - from the census depth,
 * the committee size, the seed, the bond floor and the protocol version. A
 * rank a caller picks is a rank the OPERATOR picks: say the player about to
 * overtake you is nineteenth and they fall out of the twenty you are shown,
 * with nothing forged and nothing to notice.
 *
 * The board is the authority. A `rank` on the caller's object is IGNORED
 * rather than refused, which is the same treatment RESOLVE gives a census
 * entry's claimed roles and key: the object is somebody's summary, and the
 * signed thing beside it is what counts.
 */
test('a rank the caller writes on the object is ignored; the board decides', () => {
  const far = Array.from({ length: 4 }, (_, i) => ({
    entryId: id(i), playerPubkey: id(i), x: 0, z: 0,
  }));
  const near = Array.from({ length: 4 }, (_, i) => ({
    entryId: id(100 + i), playerPubkey: id(100 + i),
    x: 900 * 65536 + i * 65536, z: 900 * 65536,
  }));
  const viewer = { entryId: id(200), x: 900 * 65536, z: 900 * 65536 };

  // the board says 0..3 are the leaders
  const board = boardOf([...far.map((_, i) => [i, 100000 - i]),
                         ...near.map((_, i) => [100 + i, 10 - i])]);
  const honest = interestSet(viewer, [...far, ...near], { limit: 4, board })
    .map((o) => o.entryId[31] | (o.entryId[30] << 8));

  // A LIE, WRITTEN ON THE OBJECTS: the real leaders are demoted and the
  // stragglers promoted. Nothing may move.
  const lied = [
    ...far.map((o, i) => ({ ...o, rank: 900 + i })),
    ...near.map((o, i) => ({ ...o, rank: i })),
  ];
  const lying = interestSet(viewer, lied, { limit: 4, board })
    .map((o) => o.entryId[31] | (o.entryId[30] << 8));

  assert.deepEqual(lying, honest,
    'a rank written on the caller\'s object changed who the player sees');
  assert.equal(lying.filter((n) => n < 10).length, 2, 'the leaders half is not the board\'s');

  // and with NO board at all there are no leaders: the whole budget goes to
  // the nearest, because nobody has a standing to be a leader by
  const blind = interestSet(viewer, lied, { limit: 4 })
    .map((o) => o.entryId[31] | (o.entryId[30] << 8));
  assert.equal(blind.every((n) => n >= 100), true,
    'somebody was made a leader without a board saying so');
});

/**
 * SOMEBODY STILL DRIVING HAS NO STANDING, AND THAT IS NOT A GAP. A board is
 * built from results the committee has made final, and mid-round most players
 * have none. They are still watchable as neighbours; they join the leaders
 * half when their result is final. Late join is why finals arrive during a
 * round at all - each entrant gets T_run from their own start.
 */
test('a player with no final yet is a neighbour, never a leader', () => {
  const finished = { entryId: id(1), playerPubkey: id(1), x: 0, z: 0 };
  const driving = { entryId: id(2), playerPubkey: id(2), x: 65536, z: 0 };
  const viewer = { entryId: id(3), x: 0, z: 0 };

  const board = boardOf([[1, 900]]);
  assert.equal(board.rows.length, 1, 'the board ranked somebody who has no final');

  // one signer node: the leaders half of one is zero, so the nearest wins it - and
  // the nearest is the one standing on the viewer
  const one = interestSet(viewer, [finished, driving], { limit: 1, board });
  assert.equal(one[0].entryId[31], 1);

  // two signer nodes: one leader, one neighbour, and the unranked player is the
  // neighbour rather than a second leader
  const two = interestSet(viewer, [finished, driving], { limit: 2, board })
    .map((o) => o.entryId[31]);
  assert.deepEqual(two.sort(), [1, 2]);

  // A REFUNDED RUN IS NOT A LEADER EITHER: the board shows it unranked, and
  // unranked is not a place, so it cannot be at the top of anybody's twenty.
  //
  // The refunded pair are placed FAR AWAY and the unranked four CLOSE, so the
  // two halves disagree about them: the nearest half would never reach the far
  // pair, and a leaders half that mistook `rank: null` for a standing would
  // take them first. Putting them near would have hidden the difference -
  // which is how that mutant first survived.
  const refundedFar = [0, 1].map((i) => ({
    entryId: id(300 + i), playerPubkey: id(300 + i),
    x: 500 * 65536, z: 500 * 65536 + i * 65536,
  }));
  const stillDriving = [0, 1, 2, 3].map((i) => ({
    entryId: id(400 + i), playerPubkey: id(400 + i), x: (i + 1) * 65536, z: 0,
  }));
  const allRefunds = boardOf(refundedFar.map((_, i) => [300 + i, 900 - i]), VOID);
  assert.deepEqual(allRefunds.rows.map((r) => r.rank), [null, null]);

  const signerNodes = interestSet({ entryId: id(800), x: 0, z: 0 },
    [...refundedFar, ...stillDriving], { limit: 4, board: allRefunds })
    .map((o) => (o.entryId[30] << 8) | o.entryId[31]);

  assert.equal(signerNodes.some((n) => n >= 300 && n < 302), false,
    'a refunded run was given a place in the leaders half');
  assert.deepEqual(signerNodes.sort((a, b) => a - b), [400, 401, 402, 403],
    'the signer nodes did not all go to the nearest');
});

/**
 * AND THE STANDING IS THE PLAYER'S, NOT THE ENTRY'S. A board keys by
 * `playerPubkey` and a subscription keys by `entryId`; they are different
 * bytes, and a lookup on the wrong one finds nobody - which looks exactly like
 * a field of players who have not finished yet. Every fixture above used the
 * same bytes for both, so a mutant keyed on the entry survived.
 */
test('a standing is looked up by the player key, not by the entry id', () => {
  // The board's number one is placed FARTHEST away. A correct lookup gives it
  // the leaders signer node; a lookup on the entry id finds nobody, leaves the leaders
  // half empty, and the signer nodes go to the nearest - so the top of the board
  // disappears. With everyone equidistant the two would agree and the test
  // would measure nothing, which is how that mutant first survived.
  const players = [
    { entryId: id(700), playerPubkey: id(0), x: 900 * 65536, z: 0 },
    { entryId: id(701), playerPubkey: id(1), x: 2 * 65536, z: 0 },
    { entryId: id(702), playerPubkey: id(2), x: 3 * 65536, z: 0 },
    { entryId: id(703), playerPubkey: id(3), x: 4 * 65536, z: 0 },
  ];
  const viewer = { entryId: id(800), x: 0, z: 0 };
  const board = boardOf([[0, 900], [1, 800], [2, 700], [3, 600]]);

  assert.notEqual(toHexish(players[0].entryId), toHexish(players[0].playerPubkey),
    'the fixture uses the same bytes for both, so it measures nothing');
  assert.equal(board.rows[0].rank, 1);
  assert.equal(toHexish(board.rows[0].playerPubkey), toHexish(id(0)));

  const set = interestSet(viewer, players, { limit: 2, board })
    .map((o) => (o.entryId[30] << 8) | o.entryId[31]);

  assert.equal(set.length, 2);
  assert.equal(set.includes(700), true,
    'the top of the board lost its signer node, so the standing was looked up on the wrong key');
  assert.equal(set.includes(701), true, 'the nearest did not get the other signer node');
});

const toHexish = (b) => [...b].map((v) => v.toString(16)).join('');

/**
 * A TRUCK WITH NO PLAYER KEY HAS NO STANDING - not one borrowed from its entry
 * id.
 *
 * A board keys by player; a subscription keys by entry. They are different
 * namespaces, and the lookup used to fall back from one to the other. Measured
 * before it was removed: an object with no `playerPubkey` at all took a
 * leaders signer node, on a board that ranked those same bytes as a player key.
 */
test('an other with no player key is never a leader', () => {
  const far = { entryId: id(5), x: 900 * 65536, z: 0 };              // no player key
  const a = { entryId: id(6), playerPubkey: id(6), x: 65536, z: 0 };
  const b = { entryId: id(7), playerPubkey: id(7), x: 2 * 65536, z: 0 };
  const viewer = { entryId: id(9), x: 0, z: 0 };

  // a board that ranks the FAR one's entry-id bytes as though they were a
  // player key - the only way the old fallback could be seen
  const board = { rows: [{ playerPubkey: id(5), rank: 1 }] };

  const set = interestSet(viewer, [far, a, b], { limit: 2, board })
    .map((o) => o.entryId[31]);
  assert.equal(set.includes(5), false,
    'a truck with no player key took a leaders signer node under its entry id');
  assert.deepEqual(set.sort(), [6, 7], 'the signer nodes did not go to the nearest');

  // and the same truck WITH the key is a leader, so this is the key and not
  // the distance doing the work
  const named = { ...far, playerPubkey: id(5) };
  const withKey = interestSet(viewer, [named, a, b], { limit: 2, board })
    .map((o) => o.entryId[31]);
  assert.equal(withKey.includes(5), true, 'the board\'s leader lost its signer node');
});

/**
 * AND THE BOARD REACHES THE FUNCTION A NODE ACTUALLY CALLS.
 *
 * `fanOut` is what runs once per broadcast; `interestSet` is what it calls. A
 * refactor that dropped the board on the way through would empty the leaders
 * half for every player at once, and only the `interestSet` tests would have
 * noticed.
 */
test('fanOut carries the board through to every viewer', () => {
  const players = [
    { entryId: id(1), playerPubkey: id(1), x: 900 * 65536, z: 0 },   // far, ranked 1
    { entryId: id(2), playerPubkey: id(2), x: 65536, z: 0 },
    { entryId: id(3), playerPubkey: id(3), x: 2 * 65536, z: 0 },
    { entryId: id(4), playerPubkey: id(4), x: 3 * 65536, z: 0 },
  ];
  const board = boardOf([[1, 900]]);

  const seen = (r, n) => [...r.sets.values()][n].map((o) => o.entryId[31]).sort();
  const withBoard = fanOut(players, { limit: 2, board });
  const without = fanOut(players, { limit: 2 });

  assert.deepEqual(seen(withBoard, 1), [1, 3], 'the leader did not reach this viewer');
  assert.deepEqual(seen(without, 1), [3, 4], 'without a board the nearest should fill both');
  assert.notDeepEqual(seen(withBoard, 1), seen(without, 1),
    'the board made no difference, so fanOut is dropping it');

  // every viewer gets the same budget either way
  assert.equal(withBoard.frames, without.frames);
});
