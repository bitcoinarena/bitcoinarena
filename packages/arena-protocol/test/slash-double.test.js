// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.3 ROW 1: A NODE THAT SIGNED TWO DIFFERENT RESULTS FOR ONE PLAYER.
//
// "Signing two different results for the same (round, player) | The two signed
// results."
//
// The purest of the rows. Rows 3 and 4 recompute an `F`; row 2 needs somebody
// to have replayed. This one only compares, so no attesting party enters at
// any point and the two objects ARE the offence - which is exactly what 13B
// already means one level down, where two marks at one tick forfeit a player.
// The same rule with the sides swapped: a player who says two things about one
// tick loses the stake, a node that says two things about one player loses the
// bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../src/result.js';
import {
  slashHoldsOnDoubleSign, orderedResultIds, slashCommitment, TWO_RESULTS,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const PLAYER = b32(0x02);
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const advert = { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 };

const resultOf = (over = {}) => ({
  roundId: ROUND, playerPubkey: PLAYER, outcome: 'DELIVERED', score: 4200,
  transcriptHash: b32(0x44), simCoreHash: b32(0x33), nodePubkey: NODE, ...over,
});
const sign = (r, n = 7) => joinSignedResult(encodePlayerResult(r), new Uint8Array(64).fill(n));

// The same round and player, two different answers: delivered, and failed.
const DELIVERED = resultOf();
const FAILED = resultOf({ outcome: 'FAILED', score: 0 });

const proofFor = (a, b, over = {}) => {
  const { named, other } = orderedResultIds(resultId(a), resultId(b));
  return {
    roundId: ROUND, playerPubkey: PLAYER, nodePubkey: NODE,
    transcriptHash: other, signedResultId: named,
    bondTxid: BOND, bondVout: 3, ...over,
  };
};
const ask = (a, b, over = {}) => slashHoldsOnDoubleSign({
  proof: proofFor(a, b), signedResults: [sign(a), sign(b)], advert, committee, ...over,
});

/**
 * THE BEFORE AND AFTER. The same node, the same bond, the same player - and
 * the only thing that moves is whether the second result says something else.
 */
test('two different results for one player slash the named bond', () => {
  const before = ask(DELIVERED, DELIVERED);
  assert.equal(before.slashed, false, 'a retransmission was slashed');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED for one');
  assert.match(before.why, /the same result, signed twice/);

  const after = ask(DELIVERED, FAILED);
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, TWO_RESULTS);
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.equal(toHex(after.commitment), toHex(slashCommitment(proofFor(DELIVERED, FAILED))));
});

/**
 * ONE OFFENCE, ONE COMMITMENT.
 *
 * A pair that could be written either way round is two proofs of one offence
 * with two different hashes, and 5A.3B step 4 puts that hash on chain: an
 * auditor could not tell one double-signing from two.
 */
test('the pair is named in one order, so one offence cannot be minted twice', () => {
  const forwards = ask(DELIVERED, FAILED);
  const backwards = ask(FAILED, DELIVERED);
  assert.equal(forwards.slashed, true);
  assert.equal(backwards.slashed, true, 'the order the evidence arrives in is not the offence');
  assert.equal(toHex(forwards.commitment), toHex(backwards.commitment),
    'one offence must have exactly one commitment');

  // and a proof that names them the other way round is refused rather than
  // being a second valid proof of the same thing
  const swapped = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, FAILED, {
      signedResultId: proofFor(DELIVERED, FAILED).transcriptHash,
      transcriptHash: proofFor(DELIVERED, FAILED).signedResultId,
    }),
    signedResults: [sign(DELIVERED), sign(FAILED)], advert, committee,
  });
  assert.equal(swapped.slashed, false);
  assert.match(swapped.why, /named in the wrong order/);
});

/**
 * AND EACH HALF OF THE PAIR IS PINNED ON ITS OWN.
 *
 * Found by a mutant that survived: checking only `signedResultId` left every
 * test green, because the swap test above moves BOTH fields at once. That is a
 * free variable in a body whose hash goes on chain - the same hole row 4 had -
 * so each half is asserted alone.
 */
test('neither half of the pair may be left free', () => {
  const right = proofFor(DELIVERED, FAILED);
  const results = [sign(DELIVERED), sign(FAILED)];

  const otherLoose = slashHoldsOnDoubleSign({
    proof: { ...right, transcriptHash: b32(0x7e) }, signedResults: results, advert, committee,
  });
  assert.equal(otherLoose.slashed, false, 'the second id of the pair was never checked');
  assert.match(otherLoose.why, /named in the wrong order/);

  const namedLoose = slashHoldsOnDoubleSign({
    proof: { ...right, signedResultId: b32(0x7e) }, signedResults: results, advert, committee,
  });
  assert.equal(namedLoose.slashed, false, 'the first id of the pair was never checked');
  assert.match(namedLoose.why, /named in the wrong order/);
});

test('the lower id is the one the proof names', () => {
  const a = resultId(DELIVERED);
  const b = resultId(FAILED);
  const { named, other } = orderedResultIds(a, b);
  assert.deepEqual(orderedResultIds(b, a), { named, other }, 'the order is the bytes, not the call');
  assert.equal(toHex(named) < toHex(other), true);
});

test('a result the proof does not name is not evidence of this pair', () => {
  const third = resultOf({ score: 1 });
  const no = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, FAILED),
    signedResults: [sign(DELIVERED), sign(third)], advert, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /named in the wrong order/,
    'the proof names a pair, and this is a different pair');
});

test('it is a pair, and no other number of results', () => {
  for (const many of [[], [sign(DELIVERED)], [sign(DELIVERED), sign(FAILED), sign(FAILED)]]) {
    const no = slashHoldsOnDoubleSign({
      proof: proofFor(DELIVERED, FAILED), signedResults: many, advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, /this offence is a PAIR/);
  }
  const notAnArray = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, FAILED), signedResults: undefined, advert, committee,
  });
  assert.equal(notAnArray.slashed, false);
});

/**
 * TWO NODES DISAGREEING IS NOT ONE NODE LYING. That is 13C's no-quorum case,
 * which VOIDs or FORFEITS an entry, and it must not take anybody's bond.
 */
test('two results by different nodes are a committee disagreeing, not an offence', () => {
  const theirs = resultOf({ outcome: 'FAILED', score: 0, nodePubkey: b32(0x22) });
  const no = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, theirs), signedResults: [sign(DELIVERED), sign(theirs)],
    advert, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /signed by a different node/);
});

test('two results about different players or rounds are two honest answers', () => {
  for (const [over, why] of [
    [{ playerPubkey: b32(0x0d), outcome: 'FAILED', score: 0 }, /different player/],
    [{ roundId: b32(0x0d), outcome: 'FAILED', score: 0 }, /different round/],
  ]) {
    const other = resultOf(over);
    const no = slashHoldsOnDoubleSign({
      proof: proofFor(DELIVERED, other), signedResults: [sign(DELIVERED), sign(other)],
      advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, why);
  }
});

test('a different signature over the same result is still one result', () => {
  const no = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, DELIVERED),
    signedResults: [sign(DELIVERED, 7), sign(DELIVERED, 9)], advert, committee,
  });
  assert.equal(no.slashed, false, 'a re-signed retransmission is not two answers');
  assert.match(no.why, /the same result, signed twice/);
});

test('every field of the result is one the pair can differ in', () => {
  for (const over of [{ outcome: 'FAILED' }, { score: 4201 }, { transcriptHash: b32(0x45) },
                      { simCoreHash: b32(0x34) }]) {
    const other = resultOf(over);
    assert.equal(ask(DELIVERED, other).slashed, true, JSON.stringify(over));
  }
});

test('the accuser cannot name a bond the node never advertised', () => {
  const someoneElses = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, FAILED, { bondTxid: b32(0x99) }),
    signedResults: [sign(DELIVERED), sign(FAILED)], advert, committee,
  });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = slashHoldsOnDoubleSign({
    proof: proofFor(DELIVERED, FAILED, { bondVout: 4 }),
    signedResults: [sign(DELIVERED), sign(FAILED)], advert, committee,
  });
  assert.equal(wrongVout.slashed, false, 'a different output is a different bond');
  assert.equal(ask(DELIVERED, FAILED, { advert: undefined }).slashed, false);
});

test('a stranger cannot be slashed for a round they were not serving', () => {
  const theirs = [resultOf({ nodePubkey: b32(0x66) }),
                  resultOf({ nodePubkey: b32(0x66), outcome: 'FAILED', score: 0 })];
  const no = slashHoldsOnDoubleSign({
    proof: proofFor(theirs[0], theirs[1], { nodePubkey: b32(0x66) }),
    signedResults: theirs.map((r) => sign(r)),
    advert: { nodePubkey: b32(0x66), bondTxid: BOND, bondVout: 3 }, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /is not on this round's committee/);
  assert.equal(ask(DELIVERED, FAILED, { committee: [] }).slashed, false);
});

test('rubbish is refused as evidence rather than decoded into an offence', () => {
  for (const bad of [new Uint8Array(0), new Uint8Array(232), new Uint8Array(10)]) {
    const no = slashHoldsOnDoubleSign({
      proof: proofFor(DELIVERED, FAILED), signedResults: [sign(DELIVERED), bad],
      advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, /not a signed result|named in the wrong order/);
  }
});
