// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §5A.3: WHERE A SLASHED BOND GOES (slashing rule v2, RULED 2026-11-02, kanban #976).
//
// "Each affected player gets their real loss, once, and nothing more. The rest of the bond goes to the protocol reserves. Nothing goes to the
// nodes, nothing goes to the developers, nothing goes back to the slashed node, and nothing is burned."
//
// Pure, and it moves nothing: this says what a bond owes. Spending it is arbiter.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { SLASH_REMAINDERS } from '../src/constants.js';
import * as constants from '../src/constants.js';
import * as slash from '../src/slash.js';
import { slashDistribution, realLosses, affectedEntries, REPLAY_CONTRADICTS, TWO_RESULTS } from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(0x01);
const A = b32(0xa1), B = b32(0xa2), C = b32(0xa3), D = b32(0xa4);
const contract = { slashRemainder: 'SPLIT' };
const key = toHex;
const row = (pubkey, outcome, score) => ({ pubkey, playerPubkey: pubkey, stakeMsat: 1_000_000n, feeMsat: 0n, donationMsat: 0n, netStakeMsat: 1_000_000n, activated: true, outcome, score });
// four players of 1000 sat: two delivered, two failed: one paying rank, so the winner takes the pool of 2000 sat
const settled = [row(A, 'DELIVERED', 100), row(B, 'DELIVERED', 50), row(C, 'FAILED', 0), row(D, 'FAILED', 0)];
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n);

test('the amounts are not numbers in the protocol: no share of a bond, no split with the nodes and the developers', () => {
  assert.deepEqual(SLASH_REMAINDERS, ['SPLIT'], 'one value: nothing is ever burned, so a round cannot name a burn');
  for (const gone of ['SLASH_TO_PLAYERS_BPS', 'splitNodesDevelopers', 'NODE_SHARE_PCT']) assert.equal(constants[gone], undefined, gone);
  assert.equal(slash.playersShares, undefined, 'a share of the bond is withdrawn: a loss is an amount');
});

test('a late objection: the lowered player gets what F owed less what the settlement paid, and the rest of the bond goes to the reserves', () => {
  // B delivered, and the false result gave them a low score; the truth was first place
  const truth = [{ pubkey: B, outcome: 'DELIVERED', score: 200 }];
  const affected = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: B, entries: settled, signed: { outcome: 'DELIVERED', score: 50 }, replayed: truth[0] }).affected;
  assert.deepEqual(affected.map((e) => key(e.playerPubkey)), [key(B)]);
  const losses = realLosses({ roundId: ROUND, entries: settled, truth, affected });
  assert.deepEqual([...losses], [[key(B), 2_000_000n]], 'should have had 1000 back and the 2000 pool, did get 1000 back');
  const r = slashDistribution({ escrowSats: 100_000n, roundId: ROUND, contract, losses });
  console.log('  FACTS (late objection):', JSON.stringify({ playersMsat: String(r.playersMsat), reservesMsat: String(r.reservesMsat) }));
  assert.equal(r.players.get(key(B)), 2_000_000n);
  assert.equal(r.reservesMsat, 98_000_000n);
  assert.equal(r.playersMsat + r.reservesMsat, 100_000_000n, 'to the msat');
  assert.equal(r.burned, 0n);
});

test('an objection in time: the result was corrected before any money moved, so nobody has a loss and the whole bond goes to the reserves', () => {
  const affected = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: B, entries: settled, signed: { outcome: 'FAILED', score: 0 }, replayed: { outcome: 'DELIVERED', score: 50 } }).affected;
  const losses = realLosses({ roundId: ROUND, entries: settled, truth: [], affected });
  assert.equal(losses.size, 0);
  const r = slashDistribution({ escrowSats: 100_000n, roundId: ROUND, contract, losses });
  assert.equal(r.players.size, 0);
  assert.equal(r.reservesMsat, 100_000_000n);
});

test('the player a false result raised has no loss, and those it pushed down do (kanban #975)', () => {
  // the false result put C first; the truth is that C failed
  const lied = [row(A, 'DELIVERED', 100), row(B, 'DELIVERED', 50), row(C, 'DELIVERED', 900), row(D, 'FAILED', 0)];
  const truth = [{ pubkey: C, outcome: 'FAILED', score: 0 }];
  const got = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: C, entries: lied, signed: { outcome: 'DELIVERED', score: 900 }, replayed: truth[0] });
  assert.equal(got.moved, 'RAISED');
  const losses = realLosses({ roundId: ROUND, entries: lied, truth, affected: got.affected });
  assert.equal(losses.has(key(C)), false, 'the favoured player is never paid');
  // the pool of 1000 went to C and C kept a stake it lost: A should have had 1000 back and the pool of 2000
  assert.equal(losses.get(key(A)), 2_000_000n);
  assert.equal(losses.has(key(B)), false, 'B got its stake back both ways');
  assert.equal(losses.has(key(D)), false, 'D lost both ways: an entry with no loss gets nothing');
});

test('two results with no replay show no loss: the whole bond goes to the reserves', () => {
  const affected = affectedEntries({ offence: TWO_RESULTS, playerPubkey: A, entries: settled }).affected;
  assert.equal(affected.length, 3, 'named, and being named is not being paid');
  const r = slashDistribution({ escrowSats: 50_000n, roundId: ROUND, contract, losses: realLosses({ roundId: ROUND, entries: settled, truth: [], affected }) });
  assert.equal(r.reservesMsat, 50_000_000n);
});

test('a VOID the truth makes of a lost run pays the stake back, and that is the loss', () => {
  const entries = [row(A, 'DELIVERED', 100), row(B, 'FAILED', 0)];
  const losses = realLosses({ roundId: ROUND, entries, truth: [{ pubkey: B, outcome: 'VOID', score: 0 }], affected: [entries[1]] });
  assert.equal(losses.get(key(B)), 1_000_000n);
});

test('one loss, once: the first proof pays it, the next only what is still owed, which is nothing', () => {
  const losses = new Map([[key(B), 2_000_000n]]);
  const first = slashDistribution({ escrowSats: 100_000n, roundId: ROUND, contract, losses });
  const second = slashDistribution({ escrowSats: 100_000n, roundId: ROUND, contract, losses, paid: first.players });
  assert.equal(first.playersMsat, 2_000_000n);
  assert.equal(second.playersMsat, 0n);
  assert.equal(second.reservesMsat, 100_000_000n, 'a later bond goes to the reserves whole');
});

test('a bond that cannot cover what it owes pays pro rata by loss, leaves the reserves nothing, and the next proof pays the rest', () => {
  const losses = new Map([[key(A), 3_000_000n], [key(B), 1_000_000n]]);
  const first = slashDistribution({ escrowSats: 1000n, roundId: ROUND, contract, losses });
  assert.equal(first.players.get(key(A)), 750_000n);
  assert.equal(first.players.get(key(B)), 250_000n);
  assert.equal(first.reservesMsat, 0n);
  assert.equal(first.shortMsat, 3_000_000n);
  const second = slashDistribution({ escrowSats: 10_000n, roundId: ROUND, contract, losses, paid: first.players });
  assert.equal(second.players.get(key(A)), 2_250_000n);
  assert.equal(second.players.get(key(B)), 750_000n);
  assert.equal(sum(first.players) + sum(second.players), 4_000_000n, 'each loss paid in full across the two, and no more');
  assert.equal(second.reservesMsat, 7_000_000n);
});

test('the leftover msat of a short bond goes by the round\'s own order and is never lost', () => {
  const losses = new Map([[key(A), 1000n], [key(B), 1000n], [key(C), 1000n]]);
  const r = slashDistribution({ escrowSats: 1n, roundId: ROUND, contract, losses });
  assert.equal(r.playersMsat, 1000n);
  assert.deepEqual([...r.players.values()].sort().map(String), ['333', '333', '334']);
});

test('a contract naming no rule this build runs is refused', () => {
  assert.throws(() => slashDistribution({ escrowSats: 1n, roundId: ROUND, contract: { slashRemainder: 'BURN' } }), /no slashing rule/);
});
