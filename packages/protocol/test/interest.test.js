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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interestSet, fanOut, distanceSquared, GHOST_SUBSCRIPTIONS, LEADER_SHARE,
} from '../src/interest.js';

const id = (n) => { const b = new Uint8Array(32); b[30] = n >> 8; b[31] = n & 255; return b; };
/** A grid of players, rank i, spaced forty metres apart in Q16.16. */
const field = (n) => Array.from({ length: n }, (_, i) => ({
  entryId: id(i), x: (i % 13) * 65536 * 40, z: Math.floor(i / 13) * 65536 * 40, rank: i,
}));

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
    assert.deepEqual(got.map((o) => o.rank), want.map((o) => o.rank),
      'a different arrival order gave a different set, or a different order');
  }

  // a tie in the score is broken by the entry id, not by position in the array
  const tied = [
    { entryId: id(9), x: 0, z: 0, rank: 5 },
    { entryId: id(3), x: 0, z: 0, rank: 5 },
    { entryId: id(7), x: 0, z: 0, rank: 5 },
  ];
  const viewer = { entryId: id(0), x: 65536, z: 0 };
  const one = interestSet(viewer, tied, { limit: 2 }).map((o) => o.entryId[31]);
  const two = interestSet(viewer, [...tied].reverse(), { limit: 2 }).map((o) => o.entryId[31]);
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
    entryId: id(i), x: 0, z: 0, rank: i,
  }));
  const neighbours = Array.from({ length: 10 }, (_, i) => ({
    entryId: id(100 + i), x: 900 * 65536 + i * 65536, z: 900 * 65536, rank: 500 + i,
  }));
  const viewer = { entryId: id(200), x: 900 * 65536, z: 900 * 65536 };

  const set = interestSet(viewer, [...leaders, ...neighbours], { limit: 8 });
  assert.equal(set.length, 8);
  const ranks = set.map((o) => o.rank);
  assert.equal(ranks.filter((r) => r < 10).length, 8 / LEADER_SHARE, 'the leaders half moved');
  assert.equal(ranks.filter((r) => r >= 500).length, 8 - 8 / LEADER_SHARE);
  assert.deepEqual(ranks.filter((r) => r < 10).sort((a, b) => a - b), [0, 1, 2, 3],
    'the leaders taken were not the top of the board');

  // the nearest half really is the nearest, not any four
  const near = ranks.filter((r) => r >= 500).sort((a, b) => a - b);
  assert.deepEqual(near, [500, 501, 502, 503]);

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
  const a = { entryId: id(1), x: 0x40000000, z: 0, rank: 1 };
  const b = { entryId: id(2), x: 0x40000000, z: 1, rank: 2 };

  const da = distanceSquared(viewer, a);
  const db = distanceSquared(viewer, b);
  assert.equal(typeof da, 'bigint');
  assert.ok(db > da, 'the further truck did not measure further');
  assert.ok(da > BigInt(Number.MAX_SAFE_INTEGER), 'the fixture is not past a double');
  assert.equal(Number(da) === Number(db), true,
    'as doubles these two are the same number, which is the point');

  assert.deepEqual(interestSet(viewer, [a, b], { limit: 1 }).map((o) => o.rank), [1],
    'the nearer of two trucks a double cannot tell apart was not chosen');

  // and the order does not rescue it: offered the other way round, still a
  assert.deepEqual(interestSet(viewer, [b, a], { limit: 1 }).map((o) => o.rank), [1]);
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
