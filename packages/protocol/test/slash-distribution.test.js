// 5A.3: WHERE A SLASHED BOND GOES.
//
// "Slashed bonds are distributed: half to the affected players of that round,
// half burned or to the remaining honest committee members of the round, as
// fixed by the Round Contract."
//
// Pure, and it moves nothing: this says who is owed what out of a bond that
// has been spent. Spending it is 5A.3B steps 3 and 5 - an arbitration set with
// MuSig2 keys - and is not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { SLASH_TO_PLAYERS_BPS, SLASH_REMAINDERS } from '../src/constants.js';
import { slashDistribution } from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(0x01);
const players = [b32(0xa1), b32(0xa2), b32(0xa3)];
const honest = [b32(0x22), b32(0x23)];
// ONE CONTRACT SHAPE NOW: the remainder has one destination and a round cannot name a burn.
const split = { slashRemainder: 'SPLIT' };
const toCommittee = split;
// NOTHING IS BURNED, so the bond is accounted for as shares plus what went to the
// federation pool. `burned` is kept in the return and asserted 0n everywhere -
// a field that silently disappeared would let a later burn come back unnoticed.
const total = (r) => [...r.shares.values()].reduce((a, b) => a + b, 0n) + r.toPool;

test('half is the spec\'s number and not a field', () => {
  assert.equal(SLASH_TO_PLAYERS_BPS, 5000);
  assert.deepEqual(SLASH_REMAINDERS, ['SPLIT'],
    'the remainder has one destination now: nothing is ever burned, so a round cannot name a burn');
});

test('half goes to the affected players and the other half is always handed out, never burned', () => {
  const shared = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: split,
    affectedPlayers: players, honestCommittee: honest,
  });
  assert.equal(shared.toPlayers, 50000n);
  // THE RULE THAT CHANGED: no round can be written that keeps the other half out of everybody's hands.
  // "Nothing is ever burned, here or anywhere in this protocol."
  assert.equal(shared.burned, 0n, 'a round burned its own remainder');
  assert.equal(shared.shares.get(toHex(honest[0])), 25000n);
  assert.equal(shared.shares.get(toHex(honest[1])), 25000n);
  assert.equal(total(shared), 100000n, 'and nothing is created or lost');
});

/**
 * REMAINDERS ARE HANDED OUT, NOT DROPPED. Floor each share, then one satoshi
 * at a time in ascending H(roundId || pubkey) - the order 22A names for fees
 * and `payout.js` already uses for the pool.
 */
test('a bond that does not divide is still handed out to the last satoshi', () => {
  for (const bond of [1n, 3n, 7n, 101n, 99999n, 1000003n]) {
    const r = slashDistribution({
      bondSats: bond, roundId: ROUND, contract: toCommittee,
      affectedPlayers: players, honestCommittee: honest,
    });
    assert.equal(total(r), bond, `${bond} did not add up`);
    for (const v of r.shares.values()) assert.ok(v >= 0n);
  }
});

test('the remainder order is the round\'s, not the list\'s', () => {
  const forwards = slashDistribution({
    bondSats: 101n, roundId: ROUND, contract: split, affectedPlayers: players,
  });
  const backwards = slashDistribution({
    bondSats: 101n, roundId: ROUND, contract: split, affectedPlayers: [...players].reverse(),
  });
  assert.deepEqual([...forwards.shares.entries()].sort(),
                   [...backwards.shares.entries()].sort(),
                   'the order the caller lists players in must not move anybody\'s satoshi');

  // AND A DIFFERENT ROUND HANDS THE LEFTOVER TO DIFFERENT PLAYERS, which is
  // the whole point of hashing the round in with the key. Measured rather than
  // asserted in general: 101 satoshi over three players is 33 each and two
  // over, and round 01 gives them to a1 and a2 while round 02 gives them to a2
  // and a3. A survivor mutant found this - the first version only checked that
  // the total still added up, which it does whoever gets the satoshi.
  const here = slashDistribution({
    bondSats: 101n, roundId: b32(0x01), contract: split, affectedPlayers: players,
  });
  const elsewhere = slashDistribution({
    bondSats: 101n, roundId: b32(0x02), contract: split, affectedPlayers: players,
  });
  assert.equal(total(elsewhere), 101n);
  assert.equal(here.shares.get(toHex(players[0])), 17n);
  assert.equal(here.shares.get(toHex(players[2])), 16n);
  assert.equal(elsewhere.shares.get(toHex(players[0])), 16n);
  assert.equal(elsewhere.shares.get(toHex(players[2])), 17n,
    'the round must decide who is rounded up, or the caller decides it');
});

/**
 * NOBODY TO PAY MEANS BURNED, which is the only direction that cannot quietly
 * become somebody's income.
 */
test('with nobody to pay, that half goes to the federation pool rather than burning', () => {
  const noPlayers = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: [], honestCommittee: honest,
  });
  assert.equal(noPlayers.burned, 0n, 'nothing is ever burned');
  assert.equal(noPlayers.toPool, 50000n, 'the players\' half went to the committee');
  // AND THE POOL'S OWN SPLIT, the same 75/25 a slashed guardian bond takes.
  assert.deepEqual(noPlayers.pool, { nodes: 37500n, developers: 12500n });
  assert.equal([...noPlayers.shares.values()].reduce((a, b) => a + b, 0n), 50000n);

  const nobody = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: [], honestCommittee: [],
  });
  assert.equal(nobody.burned, 0n);
  assert.equal(nobody.toPool, 100000n);
  assert.deepEqual(nobody.pool, { nodes: 75000n, developers: 25000n });
  assert.equal(nobody.shares.size, 0);
});

/**
 * A SLASHED NODE NEVER RECEIVES ITS OWN BOND.
 *
 * 5A.3 pays "the REMAINING honest committee members", and this file said so in
 * a comment while the code took `honestCommittee` as given - so a caller could
 * list the slashed node and hand it back half its own bond. Measured before
 * the filter existed: 25000 of 100000 satoshi.
 *
 * AND THE EXCLUDED SHARE IS BURNED, not spread over the rest. Dividing among
 * the survivors would pay them MORE the more of their colleagues were caught,
 * which is a reward for a round going wrong - measured while fixing this, one
 * of two members excluded took the other from 25000 to 50000.
 */
test('a slashed node receives none of its own bond, and its share goes to the pool', () => {
  const accused = honest[0];
  const seen = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: players, honestCommittee: honest, slashed: [accused],
  });
  assert.equal(seen.shares.get(toHex(accused)), undefined, 'it collected from its own slashing');
  assert.equal(seen.shares.get(toHex(honest[1])), 25000n,
    'and the survivor is not paid more for its colleague being caught');
  assert.equal(seen.burned, 0n, 'nothing is ever burned');
  assert.equal(seen.toPool, 25000n, 'the excluded share must go to the pool, not to the others');
  assert.equal(total(seen), 100000n);

  // two caught in one round: neither collects from the other's bond
  const both = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: players, honestCommittee: honest, slashed: honest,
  });
  assert.equal(both.shares.get(toHex(honest[0])), undefined);
  assert.equal(both.shares.get(toHex(honest[1])), undefined);
  assert.equal(both.burned, 0n);
  assert.equal(both.toPool, 50000n);
  assert.equal(total(both), 100000n);

  // and with nobody slashed the committee half is untouched
  const clean = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: players, honestCommittee: honest,
  });
  assert.equal(clean.shares.get(toHex(honest[0])), 25000n);
  assert.equal(clean.burned, 0n);
  assert.equal(clean.toPool, 0n);
});

test('an excluded member takes no leftover satoshi either - it goes to the pool', () => {
  // 101 does not divide by two, so somebody is rounded up; it must not be the
  // node whose bond this is.
  //
  // THE ACCUSED HERE IS THE ONE THAT SORTS FIRST, and that is the whole test.
  // The first version excluded the OTHER one, so the leftover landed on the
  // same node whether or not the excluded member was skipped, and a mutant
  // that let an excluded member take it survived at 0 red. Measured for this
  // round: 0x23 is first in `H(roundId || pubkey)` order.
  const accused = honest[1];
  assert.equal(toHex(accused).slice(0, 4), '2323', 'the sort order this case depends on moved');

  const r = slashDistribution({
    bondSats: 101n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: [], honestCommittee: honest, slashed: [accused],
  });
  assert.equal(r.shares.get(toHex(accused)), undefined,
    'the node whose bond this is was rounded up into a share of it');
  // 51 over two is 25 each with one over: the survivor takes its 25 plus the
  // leftover satoshi, and the excluded member's 25 burns.
  assert.equal(r.shares.get(toHex(honest[0])), 26n, 'and the survivor took the leftover');
  // 75 to the pool: 50 because there are no affected players to pay, and 25 the
  // excluded member's share. Both are burns, and neither becomes income.
  assert.equal(r.burned, 0n, 'nothing is ever burned');
  assert.equal(r.toPool, 75n, 'the excluded share went to the pool rather than to the others');
  assert.equal(total(r), 101n);
});

test('a bond of nothing pays nothing, and money is BigInt satoshi', () => {
  const none = slashDistribution({ bondSats: 0n, roundId: ROUND, contract: split,
    affectedPlayers: players });
  assert.equal(total(none), 0n);

  for (const bad of [100000, '100000', -1n, undefined])
    assert.throws(() => slashDistribution({ bondSats: bad, roundId: ROUND, contract: split }),
      /BigInt satoshi/);
  for (const bad of [undefined, {}, { slashRemainder: 'SOMEWHERE' }])
    assert.throws(() => slashDistribution({ bondSats: 1n, roundId: ROUND, contract: bad }),
      /fixes where the other half goes/);
});
