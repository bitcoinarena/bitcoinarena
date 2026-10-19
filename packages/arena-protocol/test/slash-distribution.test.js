// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.3: WHERE A SLASHED BOND GOES.
//
// "Slashed bonds are distributed: half to the affected players of that round;
// the other half 75% evenly to the active census nodes at the slashing height
// minus the round's own seats (the witnesses) and 25% to the donation set of
// §22A - the developers. Nothing is ever burned (RULED 2026-09-21),
// here or anywhere in this protocol ... so every remainder in this document has
// a recipient."
//
// THE WITNESSES ARE SUBTRACTED, NOT PAID. This suite used to assert the
// withdrawn rule - the other half to "the remaining honest committee members",
// which is the exact set the sentence above takes out. Measured on a clean
// 100000 sat bond under that rule: the two seats took 25000 each and the census
// took nothing. The numbers below are the spec's.
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
// The round's own two seats, and three other nodes in the active census.
const seats = [b32(0x22), b32(0x23)];
const others = [b32(0x31), b32(0x32), b32(0x33)];
const census = [...seats, ...others];
const split = { slashRemainder: 'SPLIT' };

const of = (r, k) => r.shares.get(toHex(k)) || 0n;
// NOTHING IS BURNED, so the bond is accounted for as every share paid, plus the
// donation set's quarter, plus what had nobody on the round to receive it.
// `burned` is kept in the return and asserted 0n everywhere - a field that
// silently disappeared would let a later burn come back unnoticed.
const total = (r) => [...r.shares.values()].reduce((a, b) => a + b, 0n) + r.toDevelopers + r.toPool;
const run = (over = {}) => slashDistribution({
  bondSats: 100000n, roundId: ROUND, contract: split,
  affectedPlayers: players, censusNodes: census, seats, ...over,
});

test('half is the spec\'s number and not a field', () => {
  assert.equal(SLASH_TO_PLAYERS_BPS, 5000);
  assert.deepEqual(SLASH_REMAINDERS, ['SPLIT'],
    'the remainder has one destination now: nothing is ever burned, so a round cannot name a burn');
});

test('a clean 100000 sat bond: players 50000, seats 0, nodes 37500, developers 12500', () => {
  const r = run();
  const facts = {
    toPlayers: String(r.toPlayers), seats: seats.map((k) => String(of(r, k))),
    toNodes: String(r.toNodes), toDevelopers: String(r.toDevelopers),
    eachOther: others.map((k) => String(of(r, k))), burned: String(r.burned),
  };
  console.log('  FACTS (a clean 100000 bond):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    toPlayers: '50000', seats: ['0', '0'], toNodes: '37500', toDevelopers: '12500',
    eachOther: ['12500', '12500', '12500'], burned: '0',
  });
  assert.equal(total(r), 100000n, 'and nothing is created or lost');
});

test('the round\'s own seats are subtracted from the census, never paid out of the bond', () => {
  const r = run();
  for (const k of seats) assert.equal(of(r, k), 0n, 'a witness was paid out of the bond it witnessed');
  // And the whole 75% really did reach the others rather than going missing.
  assert.equal(others.reduce((a, k) => a + of(r, k), 0n), r.toNodes);
});

test('an amount that does not divide evenly still sums to the bond exactly', () => {
  const r = run({ bondSats: 100001n });
  const facts = { toPlayers: String(r.toPlayers), toNodes: String(r.toNodes),
    toDevelopers: String(r.toDevelopers), eachOther: others.map((k) => String(of(r, k))) };
  console.log('  FACTS (an uneven 100001 bond):', JSON.stringify(facts));
  // The odd satoshi lands on the donation set because `toNodes` floors first;
  // nothing is dropped to make the halves look tidy.
  assert.deepEqual(facts, { toPlayers: '50000', toNodes: '37500', toDevelopers: '12501',
    eachOther: ['12500', '12500', '12500'] });
  assert.equal(total(r), 100001n);
  assert.equal(r.burned, 0n);
});

test('the leftover satoshis go by the round\'s own order, not the list\'s', () => {
  // 206 sat: 103 to the players, 77 to the nodes over three of them - 25 each and
  // TWO left, handed one at a time in ascending H(roundId || pubkey), the rule
  // 22A names for fees and payout.js already uses for the pool.
  const r = run({ bondSats: 206n });
  const each = others.map((k) => of(r, k));
  console.log('  FACTS (the remainder order):', JSON.stringify({ toNodes: String(r.toNodes), each: each.map(String) }));
  assert.equal(r.toNodes, 77n);
  assert.equal(each.reduce((a, b) => a + b, 0n), r.toNodes, 'a leftover satoshi went missing');
  assert.equal(total(r), 206n);
  // Two nodes take 26 and one takes 25 - the leftover is handed out, never dropped.
  assert.deepEqual([...each].sort().map(String), ['25', '26', '26']);
});

test('a node slashed at this height inside the census is refused, not dropped in silence', () => {
  // Its bond output is spent, and `deriveCensus` filters spent bonds - so a census
  // that still lists it is wrong, and being wrong is said out loud.
  assert.throws(() => run({ slashed: [others[0]] }),
    /still inside the active census/,
    'a census counting a spent bond was accepted');
});

test('an empty eligible set names its satoshis and stops, rather than inventing a recipient', () => {
  // The seats are the whole census here. The spec names nobody else for that 75%:
  // not the seats it just excluded, not a burn, and not the donation set.
  assert.throws(() => run({ censusNodes: seats }),
    /37500 sat of a slashed bond have no recipient/,
    'the 75% was quietly moved somewhere the rule does not name');
});

test('with nobody to pay the players\' half, it goes to the federation pool and is not burned', () => {
  const r = run({ affectedPlayers: [] });
  const facts = { toPool: String(r.toPool), pool: { nodes: String(r.pool.nodes), developers: String(r.pool.developers) },
    burned: String(r.burned), toNodes: String(r.toNodes), toDevelopers: String(r.toDevelopers) };
  console.log('  FACTS (no affected players):', JSON.stringify(facts));
  assert.deepEqual(facts, { toPool: '50000', pool: { nodes: '37500', developers: '12500' },
    burned: '0', toNodes: '37500', toDevelopers: '12500' });
  assert.equal(total(r), 100000n);
});

test('nothing is ever burned, in any of these shapes', () => {
  for (const shape of [{}, { bondSats: 100001n }, { affectedPlayers: [] }, { bondSats: 202n }]) {
    const r = run(shape);
    assert.equal(r.burned, 0n, `a burn came back in ${JSON.stringify(Object.keys(shape))}`);
  }
});
