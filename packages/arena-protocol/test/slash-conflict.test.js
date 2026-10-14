// 5A.3 ROW 5: A NODE THAT SIGNED FOR A ROUND ITS OWN OPERATOR PLAYED.
//
// 5A.13: "A selected node may not sign anything for a round in which its
// operator has an Entry Contract... If a selected node's `operator_id` also
// signed an Entry Contract in that round, the node is conflicted: its result
// signatures, payout-table signatures and settlement participation are
// invalid, and it earns no fee share. Signing anyway is a slashable offence
// with a one-artifact proof."
//
// Nothing is injected: this reads what two objects already say. And BEING
// CONFLICTED IS NOT THE OFFENCE - an operator may play a round their node was
// selected for; what 5A.13 forbids is that node signing in it, and a committee
// pushed under its threshold by conflicts is ENTRY_VOID, a refund, not a bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { entryId } from '../src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../src/result.js';
import { encodePayoutTable, payoutTableId } from '../src/payout.js';
// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../src/fee.js';
import {
  encodeSettlementRecord, settlementRecordId, slashHoldsOnConflictBefore20261014, slashHoldsOnConflict, operatorKeyOf,
  slashCommitment, OPERATOR_PLAYED,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const OPERATOR = b32(0xaa);        // the operator's own key, which also plays
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];

const advert = { nodePubkey: NODE, operatorId: toHex(OPERATOR), bondTxid: BOND, bondVout: 3 };
const entry = {
  roundId: ROUND, playerPubkey: OPERATOR, sessionPubkey: b32(0x0b),
  stakeCommitment: b32(0x0c), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
};

const result = {
  roundId: ROUND, playerPubkey: b32(0xa1), outcome: 'DELIVERED', score: 4200,
  transcriptHash: b32(0x44), simCoreHash: b32(0x33), nodePubkey: NODE,
};
const signedResult = joinSignedResult(encodePlayerResult(result), new Uint8Array(64).fill(7));

const proofFor = (id, over = {}) => ({
  roundId: ROUND, playerPubkey: OPERATOR, nodePubkey: NODE,
  transcriptHash: entryId(entry), signedResultId: id,
  bondTxid: BOND, bondVout: 3, ...over,
});
const ask = (over = {}) => slashHoldsOnConflictBefore20261014({
  proof: proofFor(resultId(result)), entry, signedByNode: signedResult,
  advert, committee, ...over,
});

/**
 * THE BEFORE AND AFTER. The same node, the same bond, the same signed result -
 * and the only thing that moves is whether the operator it declared is the one
 * holding an entry in this round.
 */
test('signing for a round your declared operator plays slashes the named bond', () => {
  const stranger = { ...entry, playerPubkey: b32(0xbb) };
  const before = ask({ entry: stranger });
  assert.equal(before.slashed, false, 'a node was slashed for somebody else\'s entry');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED for one');
  assert.match(before.why, /fires on a DECLARED conflict/);

  const after = ask();
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, OPERATOR_PLAYED);
  assert.equal(after.signed, 'result');
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.equal(toHex(after.commitment), toHex(slashCommitment(proofFor(resultId(result)))));
});

/**
 * BEING CONFLICTED IS NOT THE OFFENCE. SIGNING IS.
 *
 * 5A.13's remedy for a committee pushed under its threshold by conflicts is
 * ENTRY_VOID - a refund - and not somebody's bond. A conflicted node that
 * signed nothing has taken nothing from anybody.
 */
test('a conflicted node that signed nothing is not slashed', () => {
  for (const nothing of [undefined, new Uint8Array(0), new Uint8Array(9)]) {
    const no = ask({ signedByNode: nothing });
    assert.equal(no.slashed, false, 'a bond was taken for a conflict alone');
    assert.match(no.why, /being conflicted is not the offence/);
  }
});

/**
 * AND THE RULE ONLY FIRES ON A DECLARATION. 5A.13 says so itself: "an attacker
 * who runs nodes and plays simply declares nothing, or declares unrelated ids,
 * and the rule does not fire... defence in depth, not a Sybil control."
 */
test('a declaration that names no key conflicts with nobody', () => {
  for (const said of ['', 'somebody', toHex(OPERATOR).slice(0, 63), toHex(OPERATOR).toUpperCase(),
                      toHex(OPERATOR) + '00', undefined]) {
    const no = ask({ advert: { ...advert, operatorId: said } });
    assert.equal(no.slashed, false, `${JSON.stringify(said)} was read as a key`);
    assert.match(no.why, /declares no operator key/);
  }
  assert.equal(operatorKeyOf(advert) && toHex(operatorKeyOf(advert)), toHex(OPERATOR));
  assert.equal(operatorKeyOf({ operatorId: 'zz'.repeat(32) }), null);
});

test('all three of 5A.13\'s signatures are the offence, not just results', () => {
  const table = encodePayoutTable({ roundId: ROUND, table: [{ pubkey: b32(0xa1), amountMsat: 5n }] });
  const onTable = slashHoldsOnConflictBefore20261014({
    proof: proofFor(payoutTableId({ roundId: ROUND, table: [{ pubkey: b32(0xa1), amountMsat: 5n }] })),
    entry, signedByNode: table, advert, committee,
  });
  assert.equal(onTable.slashed, true, onTable.why);
  assert.equal(onTable.signed, 'payout table');

  const record = {
    roundId: ROUND, entryId: b32(0x0e), nodePubkey: NODE, action: 'CLAIM',
    outcome: 'FAILED', qualifies: false, state: 'FINAL', shares: 5, signatures: 5,
  };
  const onRecord = slashHoldsOnConflictBefore20261014({
    proof: proofFor(settlementRecordId(record)), entry,
    signedByNode: encodeSettlementRecord(record), advert, committee,
  });
  assert.equal(onRecord.slashed, true, onRecord.why);
  assert.equal(onRecord.signed, 'settlement record');
});

test('the entry has to be this round\'s, and the object this round\'s too', () => {
  const elsewhere = ask({ entry: { ...entry, roundId: b32(0x09) } });
  assert.equal(elsewhere.slashed, false);
  assert.match(elsewhere.why, /entry attached is for a different round/);

  const other = { ...result, roundId: b32(0x09) };
  const otherSigned = joinSignedResult(encodePlayerResult(other), new Uint8Array(64).fill(7));
  const no = slashHoldsOnConflictBefore20261014({
    proof: proofFor(resultId(other)), entry, signedByNode: otherSigned, advert, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /result attached is for a different round/);
});

test('the object attached has to be the one the proof names, and the node\'s own', () => {
  const mismatched = slashHoldsOnConflictBefore20261014({
    proof: proofFor(b32(0x7e)), entry, signedByNode: signedResult, advert, committee,
  });
  assert.equal(mismatched.slashed, false);
  assert.match(mismatched.why, /not the one this proof names/);

  const theirs = { ...result, nodePubkey: b32(0x22) };
  const theirSigned = joinSignedResult(encodePlayerResult(theirs), new Uint8Array(64).fill(7));
  const borrowed = slashHoldsOnConflictBefore20261014({
    proof: proofFor(resultId(theirs)), entry, signedByNode: theirSigned, advert, committee,
  });
  assert.equal(borrowed.slashed, false);
  assert.match(borrowed.why, /signed by a different node/);
});

/**
 * EACH HALF OF A PAIR ASSERTED ALONE. The proof names both a player and an
 * entry, and moving them together would show neither pinned - the fault that
 * survived a mutant on the row before this one.
 */
test('neither the player nor the entry may be left free', () => {
  const namedWrong = ask({ proof: proofFor(resultId(result), { playerPubkey: b32(0xbb) }) });
  assert.equal(namedWrong.slashed, false, 'the proof could name a player who did not play');
  assert.match(namedWrong.why, /names a different player than the entry does/);

  const measuredWrong = ask({ proof: proofFor(resultId(result), { transcriptHash: b32(0x7e) }) });
  assert.equal(measuredWrong.slashed, false, 'the proof could be measured against any entry');
  assert.match(measuredWrong.why, /measured against a different entry/);
});

test('the accuser cannot name a bond the node never advertised', () => {
  const someoneElses = ask({ proof: proofFor(resultId(result), { bondTxid: b32(0x99) }) });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = ask({ proof: proofFor(resultId(result), { bondVout: 4 }) });
  assert.equal(wrongVout.slashed, false, 'a different output is a different bond');
  assert.equal(ask({ advert: undefined }).slashed, false);
  assert.match(ask({ advert: { ...advert, nodePubkey: b32(0x22) } }).why,
    /no advertisement from the accused node/);
});

test('a stranger cannot be slashed for a round they were not serving', () => {
  const no = ask({ proof: proofFor(resultId(result), { nodePubkey: b32(0x66) }) });
  assert.equal(no.slashed, false);
  assert.match(no.why, /is not on this round's committee/);
  assert.equal(ask({ committee: [] }).slashed, false);
});

test('no entry at all is not an accusation', () => {
  for (const none of [undefined, {}, { roundId: 'not bytes' }]) {
    const no = ask({ entry: none });
    assert.equal(no.slashed, false);
    assert.match(no.why, /no entry contract/);
  }
});

test('since the 2026-10-14 ruling the offence is withdrawn: no proof slashes (§5A.13, kanban #360)', () => {
  const then = ask();
  assert.equal(then.slashed, true, 'the same proof slashed under the old rule');
  const now = slashHoldsOnConflict({ proof: {}, entry: {}, signedByNode: {}, advert: {}, committee: [] });
  assert.equal(now.slashed, false);
  assert.match(now.why, /withdrawn: a player declares no operator/);
});
