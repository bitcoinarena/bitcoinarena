// 5A.3 ROW 4: A SETTLEMENT ACTION WITHOUT THE AUTHORITY IT NEEDED.
//
// "Settlement action without the required 5-of-7 result and payout signatures
// | The settlement record."
//
// 23.2's table is the law: DELIVERED cancels on 5-of-7 settlement signatures,
// FAILED and FORFEIT settle only on a FINAL result with 5 preimage shares and
// 5-of-7 signatures, VOID needs nobody to act. `settlementAction` IS that
// table and it is in this package, so nothing is injected here either - the
// record's own published conditions are recomputed and compared with what was
// done. It is the one of the four remaining rows where a player's money has
// already left them when the offence happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { SETTLEMENT_THRESHOLD } from '../src/payout.js';
import { CLAIM, RETURN, EXPIRE } from '../src/lock-action.js';
import {
  encodeSettlementRecord, decodeSettlementRecord, settlementRecordId,
  slashHoldsOnSettlement, slashCommitment, SETTLED_WITHOUT_AUTHORITY,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const ENTRY = b32(0x02);
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const advert = { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 };

/** A loser settled with everything 23.2 asks for. */
const lawful = (over = {}) => ({
  roundId: ROUND, entryId: ENTRY, nodePubkey: NODE, action: CLAIM,
  outcome: 'FAILED', qualifies: false, state: 'FINAL',
  shares: SETTLEMENT_THRESHOLD, signatures: SETTLEMENT_THRESHOLD, ...over,
});

// `transcriptHash` is the object this offence is measured against, which for a
// settlement is the ENTRY whose invoice was acted on; `playerPubkey` is empty,
// because this row names no player - the entry does.
const proofFor = (bytes, over = {}) => ({
  roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE,
  transcriptHash: decodeSettlementRecord(bytes).entryId,
  signedResultId: settlementRecordId(decodeSettlementRecord(bytes)),
  bondTxid: BOND, bondVout: 3, ...over,
});

const ask = (record, over = {}) => {
  const bytes = encodeSettlementRecord(record);
  return slashHoldsOnSettlement({
    proof: proofFor(bytes), signedRecord: bytes, advert, committee, ...over,
  });
};

/**
 * THE BEFORE AND AFTER. One loser's stake, one settlement, and the only thing
 * that moves is a count the node published about itself.
 */
test('settling a loser without the signatures slashes the named bond', () => {
  const before = ask(lawful());
  assert.equal(before.slashed, false, 'a lawful settlement was slashed');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED for one');
  assert.match(before.why, /authorised CLAIM/);

  const after = ask(lawful({ signatures: 4 }));
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, SETTLED_WITHOUT_AUTHORITY);
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.match(after.why, /4 of 5 settlement signatures/);
  assert.equal(toHex(after.commitment),
    toHex(slashCommitment(proofFor(encodeSettlementRecord(lawful({ signatures: 4 }))))));
});

test('every one of 23.2\'s conditions on a settle is one a bond answers for', () => {
  for (const [over, why] of [
    [{ signatures: 4 }, /settlement signatures/],
    [{ shares: 4 }, /preimage shares/],
    [{ state: 'PROVISIONALLY_FINAL' }, /the result is PROVISIONALLY_FINAL/],
    [{ state: 'SUSPENDED' }, /the result is SUSPENDED/],
    [{ shares: 0, signatures: 0, state: '' }, /not final/],
  ]) {
    const seen = ask(lawful(over));
    assert.equal(seen.slashed, true, `${JSON.stringify(over)} was allowed to settle`);
    assert.match(seen.why, why);
  }
});

test('a forfeited stake is settled on the same five conditions', () => {
  assert.equal(ask(lawful({ outcome: 'FORFEIT' })).slashed, false);
  assert.equal(ask(lawful({ outcome: 'FORFEIT', shares: 4 })).slashed, true);
});

/**
 * DOING LESS IS NOT AN OFFENCE.
 *
 * 23.2: "the default path - nobody acting - is always the refund. That is what
 * makes infrastructure failure safe." A node that acted on nothing has taken
 * nothing from anybody, and slashing for it would invert the one direction the
 * design is built to keep safe - an operator could then be punished for
 * leaving a player their money.
 */
test('a node that did nothing is not slashed, whatever it could have done', () => {
  for (const outcome of ['FAILED', 'FORFEIT', 'DELIVERED', 'VOID']) {
    const seen = ask(lawful({ outcome, action: EXPIRE, qualifies: outcome === 'DELIVERED' }));
    assert.equal(seen.slashed, false, `doing nothing on ${outcome} was slashed`);
    assert.match(seen.why, /nobody acting is 23.2's refund path/);
  }
});

/**
 * AND THE ACTION HAS TO BE THE RIGHT ONE, not merely an authorised one.
 *
 * Settling where 23.2 cancels takes a qualifier's own stake into the pool -
 * with the very signatures that authorise a cancel. The counts are met and the
 * money still went the wrong way.
 */
test('settling where 23.2 cancels is the offence even with every signature', () => {
  const seen = ask(lawful({
    outcome: 'DELIVERED', qualifies: true, action: CLAIM,
    shares: 7, signatures: 7,
  }));
  assert.equal(seen.slashed, true, 'a qualifier\'s stake was taken with a full committee');
  assert.equal(seen.due, RETURN);
  assert.match(seen.why, /calls for RETURN .* and the node did CLAIM/);
});

test('cancelling a VOID entry is acting where nobody should have', () => {
  const seen = ask(lawful({ outcome: 'VOID', action: RETURN, signatures: 7 }));
  assert.equal(seen.slashed, true);
  assert.equal(seen.due, EXPIRE);
  assert.match(seen.why, /calls for EXPIRE/);
});

test('a lawful cancel is not an offence, and one without the signatures is', () => {
  const ok = ask(lawful({ outcome: 'DELIVERED', qualifies: true, action: RETURN, shares: 0 }));
  assert.equal(ok.slashed, false, ok.why);

  const short = ask(lawful({
    outcome: 'DELIVERED', qualifies: true, action: RETURN, signatures: 4, shares: 0,
  }));
  assert.equal(short.slashed, true);
  assert.match(short.why, /RETURN needed 4 of 5 settlement signatures/);
});

test('the evidence has to be the record the proof names', () => {
  const right = encodeSettlementRecord(lawful({ signatures: 4 }));
  const other = encodeSettlementRecord(lawful({ signatures: 3 }));
  const mismatched = slashHoldsOnSettlement({
    proof: proofFor(right), signedRecord: other, advert, committee,
  });
  assert.equal(mismatched.slashed, false);
  assert.match(mismatched.why, /not the one this proof names/);

  for (const bad of [undefined, new Uint8Array(0), new Uint8Array(9)]) {
    const no = slashHoldsOnSettlement({
      proof: proofFor(right), signedRecord: bad, advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, /no settlement record|not a settlement record/);
  }
});

test('another round or another node writing it is not this offence', () => {
  const bytes = encodeSettlementRecord(lawful({ signatures: 4, roundId: b32(0x09) }));
  const elsewhere = slashHoldsOnSettlement({
    proof: proofFor(bytes), signedRecord: bytes, advert, committee,
  });
  assert.equal(elsewhere.slashed, false);
  assert.match(elsewhere.why, /different round/);

  const theirs = encodeSettlementRecord(lawful({ signatures: 4, nodePubkey: b32(0x22) }));
  const borrowed = slashHoldsOnSettlement({
    proof: proofFor(theirs, { nodePubkey: NODE }), signedRecord: theirs, advert, committee,
  });
  assert.equal(borrowed.slashed, false);
  assert.match(borrowed.why, /written by a different node/);
});

test('the accuser cannot name a bond the node never advertised', () => {
  const bytes = encodeSettlementRecord(lawful({ signatures: 4 }));
  const someoneElses = slashHoldsOnSettlement({
    proof: proofFor(bytes, { bondTxid: b32(0x99) }), signedRecord: bytes, advert, committee,
  });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = slashHoldsOnSettlement({
    proof: proofFor(bytes, { bondVout: 4 }), signedRecord: bytes, advert, committee,
  });
  assert.equal(wrongVout.slashed, false, 'a different output is a different bond');
  assert.equal(ask(lawful({ signatures: 4 }), { advert: undefined }).slashed, false);
});

test('a stranger cannot be slashed for a round they were not settling', () => {
  // The PROOF has to accuse the stranger too. The first version left it
  // naming a committee member, so it stopped at "written by a different node"
  // and never reached the check it claimed to be about.
  const bytes = encodeSettlementRecord(lawful({ signatures: 4, nodePubkey: b32(0x66) }));
  const no = slashHoldsOnSettlement({
    proof: proofFor(bytes, { nodePubkey: b32(0x66) }), signedRecord: bytes,
    advert: { nodePubkey: b32(0x66), bondTxid: BOND, bondVout: 3 }, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /is not on this round's committee/);
  assert.equal(ask(lawful({ signatures: 4 }), { committee: [] }).slashed, false);
});

/**
 * NO FIELD OF THE PROOF IS LEFT FREE ON THIS ROW.
 *
 * Rows 2 and 3 pin both of these and this one pinned neither - a hole in a
 * body whose hash goes on chain, because an accuser could vary them at will
 * and mint unboundedly many different valid proofs of one offence. And the
 * record names an ENTRY rather than a player, so a free `playerPubkey` could
 * put somebody's name on a settlement that was never about them.
 */
test('a proof cannot name another entry, or a player at all', () => {
  const bytes = encodeSettlementRecord(lawful({ signatures: 4 }));

  const elsewhere = slashHoldsOnSettlement({
    proof: proofFor(bytes, { transcriptHash: b32(0x77) }),
    signedRecord: bytes, advert, committee,
  });
  assert.equal(elsewhere.slashed, false);
  assert.match(elsewhere.why, /measured against a different entry/);

  const named = slashHoldsOnSettlement({
    proof: proofFor(bytes, { playerPubkey: b32(0xa1) }),
    signedRecord: bytes, advert, committee,
  });
  assert.equal(named.slashed, false);
  assert.match(named.why, /this row names no player/);

  // and the entry the record DID act on is the one that holds
  assert.equal(ask(lawful({ signatures: 4, entryId: b32(0x0e) })).slashed, true,
    'the proof follows the record\'s own entry');
});

test('the record survives the round trip and every field is inside its id', () => {
  const r = lawful();
  const back = decodeSettlementRecord(encodeSettlementRecord(r));
  assert.deepEqual(back, r);
  assert.equal(toHex(settlementRecordId(back)), toHex(settlementRecordId(r)));

  const was = toHex(settlementRecordId(r));
  for (const over of [{ roundId: b32(9) }, { entryId: b32(9) }, { nodePubkey: b32(9) },
                      { action: RETURN }, { outcome: 'FORFEIT' }, { qualifies: true },
                      { state: 'SUSPENDED' }, { shares: 4 }, { signatures: 4 }])
    assert.notEqual(toHex(settlementRecordId(lawful(over))), was, JSON.stringify(over));

  const longer = new Uint8Array(encodeSettlementRecord(r).length + 1);
  longer.set(encodeSettlementRecord(r));
  assert.throws(() => decodeSettlementRecord(longer), /trailing bytes/);
});
