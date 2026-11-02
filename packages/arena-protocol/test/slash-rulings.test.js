// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §5A.3's three rulings of 2026-09-22: the slashing height, who was affected, and one round with
// several slashed nodes.
//
// These were the three questions an implementer could not answer from the spec, and the spec now
// answers them. Nothing here decides anything - each test is the ruled sentence, read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slashHeightIsValid, affectedEntries, playersShares, resultMoved, NAMES_ONE_ENTRY, OFFENCES,
  TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F, SETTLED_WITHOUT_AUTHORITY,
  OPERATOR_PLAYED, FEE_WITHOUT_SERVICE, AUDIT_CONTRADICTED,
} from '../src/slash.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(0x01);
const ALICE = b32(0xa1), BOB = b32(0xa2), CARA = b32(0xa3), OPER = b32(0xa4);
// A round with four entries: three paying players and the operator's own, plus one that never paid.
const entries = [
  { playerPubkey: ALICE, netStakeMsat: 100000n, activated: true, operatorOwn: false },
  { playerPubkey: BOB, netStakeMsat: 300000n, activated: true, operatorOwn: false },
  { playerPubkey: CARA, netStakeMsat: 0n, activated: false, operatorOwn: false },
  { playerPubkey: OPER, netStakeMsat: 200000n, activated: true, operatorOwn: true },
];

test('the slashing height is one the arbitration set names, between census height and the tip', () => {
  const at = (h) => slashHeightIsValid({ slashHeight: h, censusHeight: 900000, tipHeight: 900100 });
  const facts = {
    atCensus: at(900000).ok, inside: at(900050).ok, atTip: at(900100).ok,
    belowCensus: at(899999).ok, aboveTip: at(900101).ok,
  };
  console.log('  FACTS (the slashing height):', JSON.stringify(facts));
  assert.deepEqual(facts, { atCensus: true, inside: true, atTip: true, belowCensus: false, aboveTip: false });
  // AND THE REFUSALS SAY WHICH BOUND, because "invalid height" tells an arbitration set nothing.
  assert.match(at(899999).why, /below the round's census height/);
  assert.match(at(900101).why, /above the tip/);
});

const LOWERED = { signed: { outcome: 'FAILED', score: 10 }, replayed: { outcome: 'DELIVERED', score: 800 } };

test('three offences name one entry and the other four name the paying field (kanban #724, #725, #975)', () => {
  assert.deepEqual(NAMES_ONE_ENTRY, [TWO_RESULTS, REPLAY_CONTRADICTS, AUDIT_CONTRADICTED]);
  const named = (offence) => affectedEntries({ offence, playerPubkey: ALICE, entries, ...LOWERED })
    .affected.map((e) => toHex(e.playerPubkey).slice(0, 2));
  const facts = Object.fromEntries(OFFENCES.map((o) => [o, named(o)]));
  console.log('  FACTS (affected by offence):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    // a doubled result says nothing about which way it went, so the named player collects nothing from it
    [TWO_RESULTS]: ['a2', 'a4'],
    // a result that lowered the one the proof is about harmed them
    [REPLAY_CONTRADICTS]: ['a1'],
    [AUDIT_CONTRADICTED]: ['a1'],
    // every financially activated entry - Cara never paid, so she is not harmed by a money offence
    [TABLE_IS_NOT_F]: ['a1', 'a2', 'a4'],
    [SETTLED_WITHOUT_AUTHORITY]: ['a1', 'a2', 'a4'],
    [FEE_WITHOUT_SERVICE]: ['a1', 'a2', 'a4'],
    // ... except the operator's own, which §5A.13 voids
    [OPERATOR_PLAYED]: ['a1', 'a2'],
  });
});

test('a raised result pays the players it harmed and never the one it favoured (kanban #975)', () => {
  for (const offence of [REPLAY_CONTRADICTS, AUDIT_CONTRADICTED]) {
    const said = affectedEntries({ offence, playerPubkey: ALICE, entries, signed: { outcome: 'DELIVERED', score: 900 }, replayed: { outcome: 'DELIVERED', score: 100 } });
    assert.equal(said.moved, 'RAISED');
    assert.deepEqual(said.affected.map((e) => toHex(e.playerPubkey).slice(0, 2)), ['a2', 'a4'], offence);
  }
  // a run that did not move outcome or score favours nobody: the named player still collects nothing
  const same = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: ALICE, entries, signed: { outcome: 'FAILED', score: 7 }, replayed: { outcome: 'FAILED', score: 7 } });
  assert.deepEqual([same.moved, same.affected.length], ['SAME', 2]);
  // the only paying entry raised: nobody to pay, and the half goes to the pool (slashDistribution)
  const alone = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: ALICE, entries: [entries[0]], signed: { outcome: 'DELIVERED', score: 2 }, replayed: { outcome: 'FAILED', score: 1 } });
  assert.deepEqual(alone.affected, []);
});

test('which way a false result went is what a payout reads: delivered, then a stake back, then lost, then the score', () => {
  const r = (outcome, score = 0) => ({ outcome, score });
  assert.equal(resultMoved({ signed: r('DELIVERED', 1), replayed: r('FAILED', 999) }), 'RAISED');
  assert.equal(resultMoved({ signed: r('VOID'), replayed: r('FORFEIT') }), 'RAISED');
  assert.equal(resultMoved({ signed: r('FAILED', 999), replayed: r('VOID') }), 'LOWERED');
  assert.equal(resultMoved({ signed: r('FORFEIT'), replayed: r('DELIVERED', 1) }), 'LOWERED');
  assert.equal(resultMoved({ signed: r('DELIVERED', 5), replayed: r('DELIVERED', 6) }), 'LOWERED');
  assert.equal(resultMoved({ signed: r('DELIVERED', 5) }), null);
  assert.equal(resultMoved({ signed: r('WON'), replayed: r('FAILED') }), null);
});

test('with no replay nobody is named: who a false result harmed is not guessed', () => {
  const said = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: ALICE, entries });
  assert.equal(said.ok, false);
  assert.match(said.why, /needs both the signed result and the replay/);
});

test('a proof naming a player the round has no entry for is refused, not silently empty', () => {
  const said = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: b32(0xff), entries });
  assert.equal(said.ok, false);
  assert.match(said.why, /no entry for/);
});

test('the players\' half goes pro rata by net stake, and the leftover is handed out', () => {
  const affected = affectedEntries({ offence: TABLE_IS_NOT_F, entries }).affected;
  const got = playersShares({ toPlayers: 50000n, affected, roundId: ROUND });
  const facts = {
    alice: String(got.shares.get(toHex(ALICE))), bob: String(got.shares.get(toHex(BOB))),
    oper: String(got.shares.get(toHex(OPER))), paid: String(got.paid),
  };
  console.log('  FACTS (pro rata by net stake):', JSON.stringify(facts));
  // 100000 : 300000 : 200000 of 600000 -> 1/6, 1/2, 1/3 of 50000 = 8333, 25000, 16666, and 1 left.
  assert.equal(got.paid, 50000n, 'the players\' half was not handed out in full');
  assert.equal(got.shares.get(toHex(BOB)) > got.shares.get(toHex(ALICE)), true,
    'the bigger net stake did not take the bigger share');
});

test('with nobody harmed who paid anything, the split says so rather than returning zero', () => {
  const said = playersShares({ toPlayers: 50000n, affected: [], roundId: ROUND });
  assert.equal(said.ok, false);
  assert.match(said.why, /nobody to divide among/);
});

test('one round with several slashed nodes: each bond pays the players its own proof names', () => {
  // Two proofs against two nodes in one round: a replay contradiction about Alice, and a bad table.
  // Nothing is pooled - each proof's affected[] is a function of its OWN offence.
  const one = affectedEntries({ offence: REPLAY_CONTRADICTS, playerPubkey: ALICE, entries, ...LOWERED }).affected;
  const two = affectedEntries({ offence: TABLE_IS_NOT_F, entries }).affected;
  const facts = { fromTheReplayProof: one.map((e) => toHex(e.playerPubkey).slice(0, 2)),
    fromTheTableProof: two.map((e) => toHex(e.playerPubkey).slice(0, 2)) };
  console.log('  FACTS (two proofs, one round):', JSON.stringify(facts));
  assert.deepEqual(facts, { fromTheReplayProof: ['a1'], fromTheTableProof: ['a1', 'a2', 'a4'] });
  // Alice is named by both, so she is paid from both bonds - not once out of a pooled pot.
  assert.equal(one.some((e) => toHex(e.playerPubkey) === toHex(ALICE)), true);
  assert.equal(two.some((e) => toHex(e.playerPubkey) === toHex(ALICE)), true);
});
