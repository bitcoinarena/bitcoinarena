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
const burn = { slashRemainder: 'BURN' };
const toCommittee = { slashRemainder: 'COMMITTEE' };
const total = (r) => [...r.shares.values()].reduce((a, b) => a + b, 0n) + r.burned;

test('half is the spec\'s number and not a field', () => {
  assert.equal(SLASH_TO_PLAYERS_BPS, 5000);
  assert.deepEqual(SLASH_REMAINDERS, ['BURN', 'COMMITTEE'],
    'the contract fixes the destination, which is the alternative 5A.3 offers');
});

test('half goes to the affected players and the rest where the contract says', () => {
  const burned = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: burn,
    affectedPlayers: players, honestCommittee: honest,
  });
  assert.equal(burned.toPlayers, 50000n);
  assert.equal(burned.burned, 50000n, 'a burn keeps the other half out of everybody\'s hands');
  assert.equal(total(burned), 100000n, 'and nothing is created or lost');
  assert.equal([...burned.shares.values()].reduce((a, b) => a + b, 0n), 50000n);

  const shared = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: players, honestCommittee: honest,
  });
  assert.equal(shared.toPlayers, 50000n);
  assert.equal(shared.burned, 0n);
  assert.equal(shared.shares.get(toHex(honest[0])), 25000n);
  assert.equal(shared.shares.get(toHex(honest[1])), 25000n);
  assert.equal(total(shared), 100000n);
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
    bondSats: 101n, roundId: ROUND, contract: burn, affectedPlayers: players,
  });
  const backwards = slashDistribution({
    bondSats: 101n, roundId: ROUND, contract: burn, affectedPlayers: [...players].reverse(),
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
    bondSats: 101n, roundId: b32(0x01), contract: burn, affectedPlayers: players,
  });
  const elsewhere = slashDistribution({
    bondSats: 101n, roundId: b32(0x02), contract: burn, affectedPlayers: players,
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
test('with nobody to pay, that half is burned rather than shared out', () => {
  const noPlayers = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: [], honestCommittee: honest,
  });
  assert.equal(noPlayers.burned, 50000n, 'the players\' half went to the committee');
  assert.equal([...noPlayers.shares.values()].reduce((a, b) => a + b, 0n), 50000n);

  const nobody = slashDistribution({
    bondSats: 100000n, roundId: ROUND, contract: toCommittee,
    affectedPlayers: [], honestCommittee: [],
  });
  assert.equal(nobody.burned, 100000n);
  assert.equal(nobody.shares.size, 0);
});

test('a bond of nothing pays nothing, and money is BigInt satoshi', () => {
  const none = slashDistribution({ bondSats: 0n, roundId: ROUND, contract: burn,
    affectedPlayers: players });
  assert.equal(total(none), 0n);

  for (const bad of [100000, '100000', -1n, undefined])
    assert.throws(() => slashDistribution({ bondSats: bad, roundId: ROUND, contract: burn }),
      /BigInt satoshi/);
  for (const bad of [undefined, {}, { slashRemainder: 'SOMEWHERE' }])
    assert.throws(() => slashDistribution({ bondSats: 1n, roundId: ROUND, contract: bad }),
      /fixes where the other half goes/);
});
