// 5A.3 ROW 6: CLAIMING A FEE SHARE 22A DOES NOT ALLOW.
//
// 22A: "A selected node earns its share only if it performed the
// contract-defined minimum service: for game/verify, the required receipts
// plus replay and signing; for settlement, participation in the settlement
// protocol during the settlement window. A conflicted node (5A.13) never
// qualifies. Unearned shares are redistributed pro rata among the other
// eligible nodes in the same role pool, keeping the total at 2%."
//
// Two ways to fail it, both in that one paragraph, and one thing that is not
// an offence at all: claiming nothing. 22A's remedy for an unearned share is
// REDISTRIBUTION, so a node that took none has cost nobody anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  encodeFeeClaim, decodeFeeClaim, feeClaimId, encodeServiceRecord,
  decodeServiceRecord, serviceRecordId, feeInputsId, slashHoldsOnFeeClaim,
  slashCommitment, FEE_WITHOUT_SERVICE,
} from '../src/slash.js';
import { nodeFeeTable, feeTableId, feeOwed, GAME_VERIFY, SETTLEMENT } from '../src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const OPERATOR = b32(0xaa);
const BOND = b32(0x55);
const MINIMUM = 20;
// THE MINIMUM IS THE ROUND'S, not this test's. It was an argument until the
// contract carried it, and a minimum a caller picks is one an operator picks -
// the same fault the objection window was moved in here to fix, and worse,
// because this number decides whether a bond is taken.
// A WHOLE CONTRACT, because the fee table hashes the round it belongs to.
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: MINIMUM, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [NODE, b32(0x22)],
};

// 22A's table for this round: one activated stake of 400000 msat, so a fee of
// 8000, 4000 to each pool, and NODE the only eligible verify seat - 4000 owed.
const feeEntries = [{ pubkey: b32(0xa1), outcome: 'DELIVERED', score: 500, stakeMsat: 400000n }];
const feeTable = nodeFeeTable({
  contract, entries: feeEntries,
  // NODE sits in both pools, which 22A allows explicitly - "an operator
  // selected for both roles earns both shares" - so each role owes it 4000 and
  // the two are separate money.
  pools: { [GAME_VERIFY]: [NODE], [SETTLEMENT]: [NODE] },
  eligible: new Set([toHex(NODE)]),
});
const OWED = feeOwed(feeTable, NODE, 'verify');
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const advert = { nodePubkey: NODE, operatorId: 'somebody', bondTxid: BOND, bondVout: 3 };

const claimOf = (over = {}) =>
  ({ roundId: ROUND, nodePubkey: NODE, role: 'verify', amountMsat: OWED, ...over });
const recordOf = (over = {}) =>
  ({ roundId: ROUND, nodePubkey: NODE, role: 'verify', served: MINIMUM, ...over });

const proofFor = (claim, record, minimum = MINIMUM, over = {}) => ({
  roundId: ROUND, playerPubkey: b32(0), nodePubkey: NODE,
  transcriptHash: feeInputsId({
    roundId: ROUND, role: claim.role, minimumServed: minimum,
    recordId: serviceRecordId(record), feeTableId: feeTableId(feeTable),
  }),
  signedResultId: feeClaimId(claim),
  bondTxid: BOND, bondVout: 3, ...over,
});

const ask = (claim, record, over = {}) => slashHoldsOnFeeClaim({
  proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
  serviceRecord: encodeServiceRecord(record), contract, feeTable, advert, committee, ...over,
});

/**
 * THE BEFORE AND AFTER. The same node, the same bond, the same claim - and the
 * only thing that moves is how much service the record says it did.
 */
test('claiming a share without the service slashes the named bond', () => {
  const before = ask(claimOf(), recordOf());
  assert.equal(before.slashed, false, 'a node was slashed for a share it earned');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED for one');
  assert.match(before.why, /served 20 of the 20 its role required/);
  assert.match(before.why, /claimed the 4000 22A owes it/);

  const after = ask(claimOf(), recordOf({ served: 19 }));
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, FEE_WITHOUT_SERVICE);
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.equal(after.served, 19);
  assert.equal(after.required, 20);
  assert.equal(after.claimedMsat, OWED);
  assert.equal(after.conflicted, false);
  assert.equal(toHex(after.commitment),
    toHex(slashCommitment(proofFor(claimOf(), recordOf({ served: 19 })))));
});

/**
 * CLAIMING MORE THAN 22A OWES IS THE SAME OFFENCE AS CLAIMING WITHOUT SERVICE.
 *
 * Row 6 decided WHETHER a node qualifies. Until the fee table existed nothing
 * said what the share IS, so a node that served in full could ask for any
 * amount and no predicate contradicted it - measured before this: `grep` found
 * no fee arithmetic anywhere in `packages/*` at all. Both faults take fee money
 * the round did not earn for it, so both take the bond.
 */
test('claiming more than the table owes slashes, and claiming it exactly does not', () => {
  assert.equal(OWED, 4000n, 'one activated stake of 400000 msat: 2% is 8000, half to each pool');

  const exact = ask(claimOf(), recordOf());
  assert.equal(exact.slashed, false, 'a node was slashed for asking what it is owed');
  assert.match(exact.why, /claimed the 4000 22A owes it/);

  const over = ask(claimOf({ amountMsat: OWED + 1n }), recordOf());
  assert.equal(over.slashed, true, 'one millisatoshi over is still over');
  assert.equal(over.offence, FEE_WITHOUT_SERVICE);
  assert.equal(over.overClaimed, true);
  assert.equal(over.owedMsat, OWED);
  assert.equal(over.claimedMsat, OWED + 1n);
  assert.equal(toHex(over.bond.txid), toHex(BOND));
  assert.match(over.why, /claimed 4001 where 22A owes it 4000/);

  // and under is not an offence: a node may ask for less than its due
  const under = ask(claimOf({ amountMsat: 1n }), recordOf());
  assert.equal(under.slashed, false, 'asking for less than the round owes took a bond');
});

test('a role 22A pays nothing for is owed nothing, and claiming for it slashes', () => {
  // 22A names two committees; `relay` is neither, so its pool owes nobody.
  const claim = claimOf({ role: 'relay', amountMsat: 1n });
  const record = recordOf({ role: 'relay', served: MINIMUM });
  const seen = ask(claim, record);
  assert.equal(seen.slashed, true, 'a role no pool pays was paid');
  assert.equal(seen.owedMsat, 0n);
  assert.equal(seen.overClaimed, true);
});

test('there is no over-claim to measure without a table', () => {
  for (const bad of [undefined, null, {}, { fee: 8000n }, { fee: 1, seats: new Map() }])
    assert.equal(ask(claimOf(), recordOf(), { feeTable: bad }).slashed, false,
      'a claim was judged against no table at all');
  assert.match(ask(claimOf(), recordOf(), { feeTable: undefined }).why,
    /no fee table to measure the claim against/);
});

test('serving more than the minimum is still the honest path', () => {
  assert.equal(ask(claimOf(), recordOf({ served: MINIMUM + 40 })).slashed, false);
  assert.equal(ask(claimOf(), recordOf({ served: 0 })).slashed, true,
    'and nothing at all is the clearest failure of any positive minimum');
});

/**
 * CLAIMING NOTHING IS NOT AN OFFENCE.
 *
 * 22A redistributes an unearned share - "keeping the total at 2%" - rather
 * than taking a bond for one nobody asked for. A node that served nothing and
 * claimed nothing has cost nobody anything.
 */
test('a node that claimed nothing is not slashed, however little it served', () => {
  const no = ask(claimOf({ amountMsat: 0n }), recordOf({ served: 0 }));
  assert.equal(no.slashed, false, 'a bond was taken for a share nobody asked for');
  assert.match(no.why, /that claim is for nothing/);
});

/**
 * AND A CONFLICTED NODE NEVER QUALIFIES, whatever it served. 22A says so in
 * the same paragraph, pointing at 5A.13.
 */
test('a conflicted node claiming a share is slashed even having served in full', () => {
  const declared = { ...advert, operatorId: toHex(OPERATOR) };
  const entry = { roundId: ROUND, playerPubkey: OPERATOR };

  const seen = ask(claimOf(), recordOf({ served: MINIMUM + 100 }), { advert: declared, entry });
  assert.equal(seen.slashed, true, 'a conflicted node was paid for serving');
  assert.equal(seen.conflicted, true);
  assert.match(seen.why, /a conflicted node never qualifies/);

  // and an operator who did not play leaves an honest claim honest
  const stranger = { roundId: ROUND, playerPubkey: b32(0xbb) };
  assert.equal(ask(claimOf(), recordOf(), { advert: declared, entry: stranger }).slashed, false);

  // as does a declaration that names nobody, which is 5A.13's own scope
  assert.equal(ask(claimOf(), recordOf(), { entry }).slashed, false,
    'operatorId "somebody" declares no key, so the rule does not fire');

  // and an entry from another round is not this round's conflict
  const otherRound = { roundId: b32(0x09), playerPubkey: OPERATOR };
  assert.equal(ask(claimOf(), recordOf(), { advert: declared, entry: otherRound }).slashed, false);
});

/**
 * THE MINIMUM IS NOT THE ACCUSER'S TO PICK.
 *
 * An accusation whose threshold is chosen after the fact makes every honest
 * claim slashable, so the record AND the minimum are bound into the proof.
 */
test('an accuser cannot raise the bar after the fact, or swap the record', () => {
  const claim = claimOf();
  const record = recordOf();

  const raised = slashHoldsOnFeeClaim({
    proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
    serviceRecord: encodeServiceRecord(record),
    contract: { ...contract, slashMinimumServed: 999 }, feeTable, advert, committee,
  });
  assert.equal(raised.slashed, false);
  assert.match(raised.why, /bound to a different record, round or minimum/);

  const swapped = slashHoldsOnFeeClaim({
    proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
    serviceRecord: encodeServiceRecord(recordOf({ served: 0 })), contract, feeTable,
    advert, committee,
  });
  assert.equal(swapped.slashed, false, 'the accuser handed in a record the proof did not name');
  assert.match(swapped.why, /bound to a different record, round or minimum/);

  for (const bad of [undefined, { slashMinimumServed: -1 }, { slashMinimumServed: 1.5 },
                     { slashMinimumServed: '20' }, {}])
    assert.equal(ask(claim, record, { contract: bad }).slashed, false,
      'a contract that names no minimum is not a licence to pick one');
});

/**
 * EACH HALF OF THE PAIR ASSERTED ALONE - the fault that survived a mutant on
 * two earlier rows, where a test moved two proof fields together and so showed
 * neither pinned.
 */
test('neither the claim nor the bound record may be left free', () => {
  const claim = claimOf();
  const record = recordOf({ served: 19 });

  const claimLoose = ask(claim, record, { proof: proofFor(claim, record, MINIMUM, { signedResultId: b32(0x7e) }) });
  assert.equal(claimLoose.slashed, false, 'the claim the proof names was never checked');
  assert.match(claimLoose.why, /not the one this proof names/);

  const boundLoose = ask(claim, record, { proof: proofFor(claim, record, MINIMUM, { transcriptHash: b32(0x7e) }) });
  assert.equal(boundLoose.slashed, false, 'the record and minimum were never bound');
  assert.match(boundLoose.why, /bound to a different record, round or minimum/);
});

test('a share is earned in its own role, and 22A pays the pools separately', () => {
  const claim = claimOf({ role: 'settlement' });
  const record = recordOf({ role: 'verify', served: 0 });
  const no = slashHoldsOnFeeClaim({
    proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
    serviceRecord: encodeServiceRecord(record), contract, feeTable, advert, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /the claim is for settlement and the record is about verify/);

  // and a settlement claim against a settlement record works the same way
  const settled = recordOf({ role: 'settlement', served: 1 });
  assert.equal(ask(claim, settled).slashed, true);
  assert.equal(ask(claim, recordOf({ role: 'settlement' })).slashed, false);
});

test('the claim and the record have to be this round\'s and this node\'s', () => {
  const claim = claimOf();
  for (const [over, why] of [
    [{ roundId: b32(0x09) }, /claim attached is for a different round/],
    [{ nodePubkey: b32(0x22) }, /claim attached was made by a different node/],
  ]) {
    const other = claimOf(over);
    const no = slashHoldsOnFeeClaim({
      proof: proofFor(other, recordOf({ served: 19 }), MINIMUM, { signedResultId: feeClaimId(other) }),
      signedClaim: encodeFeeClaim(other), serviceRecord: encodeServiceRecord(recordOf({ served: 19 })),
      contract, feeTable, advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, why);
  }

  for (const [over, why] of [
    [{ roundId: b32(0x09) }, /record attached is for a different round/],
    [{ nodePubkey: b32(0x22) }, /record attached is about a different node/],
  ]) {
    const record = recordOf({ served: 19, ...over });
    const no = slashHoldsOnFeeClaim({
      proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
      serviceRecord: encodeServiceRecord(record), contract, advert, committee,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, why);
  }
});

test('the accuser cannot name a bond the node never advertised', () => {
  const claim = claimOf();
  const record = recordOf({ served: 19 });
  const someoneElses = ask(claim, record, {
    proof: proofFor(claim, record, MINIMUM, { bondTxid: b32(0x99) }),
  });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = ask(claim, record, {
    proof: proofFor(claim, record, MINIMUM, { bondVout: 4 }),
  });
  assert.equal(wrongVout.slashed, false, 'a different output is a different bond');
  assert.equal(ask(claim, record, { advert: undefined }).slashed, false);
  assert.match(ask(claim, record, { advert: { ...advert, nodePubkey: b32(0x22) } }).why,
    /no advertisement from the accused node/);
});

test('a stranger cannot be slashed for a round they were not serving', () => {
  const claim = claimOf({ nodePubkey: b32(0x66) });
  const record = recordOf({ nodePubkey: b32(0x66), served: 0 });
  const no = slashHoldsOnFeeClaim({
    proof: proofFor(claim, record, MINIMUM, { nodePubkey: b32(0x66) }),
    signedClaim: encodeFeeClaim(claim), serviceRecord: encodeServiceRecord(record),
    contract, feeTable, advert: { nodePubkey: b32(0x66), bondTxid: BOND, bondVout: 3 }, committee,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /is not on this round's committee/);
  assert.equal(ask(claimOf(), recordOf({ served: 0 }), { committee: [] }).slashed, false);
});

test('rubbish is refused as evidence rather than decoded into an offence', () => {
  const claim = claimOf();
  const record = recordOf({ served: 19 });
  for (const bad of [new Uint8Array(0), new Uint8Array(9), encodeServiceRecord(record)])
    assert.match(ask(claim, record, { signedClaim: bad }).why,
      /not a fee claim|not the one this proof names/);
  for (const bad of [new Uint8Array(0), new Uint8Array(9), encodeFeeClaim(claim)])
    assert.match(ask(claim, record, { serviceRecord: bad }).why,
      /not a service record|bound to a different record/);
});

// `JSON.stringify` cannot serialise a BigInt, and one of these fields is
// millisatoshi. Named for the message rather than the value.
const nameOf = (over) => Object.keys(over)[0];

test('both objects survive the round trip and every field is inside their ids', () => {
  const c = claimOf();
  assert.deepEqual(decodeFeeClaim(encodeFeeClaim(c)), c);
  const wasC = toHex(feeClaimId(c));
  for (const over of [{ roundId: b32(9) }, { nodePubkey: b32(9) }, { role: 'game' },
                      { amountMsat: 142901n }])
    assert.notEqual(toHex(feeClaimId(claimOf(over))), wasC, nameOf(over));

  const r = recordOf();
  assert.deepEqual(decodeServiceRecord(encodeServiceRecord(r)), r);
  const wasR = toHex(serviceRecordId(r));
  for (const over of [{ roundId: b32(9) }, { nodePubkey: b32(9) }, { role: 'game' },
                      { served: 21 }])
    assert.notEqual(toHex(serviceRecordId(recordOf(over))), wasR, nameOf(over));

  for (const [bytes, why] of [[encodeFeeClaim(c), /trailing bytes after the fee claim/],
                              [encodeServiceRecord(r), /trailing bytes after the service record/]]) {
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    assert.throws(() => (bytes[0] === 0x0e ? decodeFeeClaim(longer) : decodeServiceRecord(longer)), why);
  }
});

test('the minimum, the record and the table are all inside the hash a proof binds to', () => {
  const base = {
    roundId: ROUND, role: 'verify', minimumServed: MINIMUM,
    recordId: serviceRecordId(recordOf()), feeTableId: feeTableId(feeTable),
  };
  const was = toHex(feeInputsId(base));

  // the table is one of them: an accuser who could name another table could
  // recompute what is owed from an eligibility set that suits them
  assert.notEqual(toHex(feeInputsId({ ...base, feeTableId: b32(0x7e) })), was, 'the table');
  assert.notEqual(toHex(feeInputsId({ ...base, minimumServed: MINIMUM + 1 })), was, 'the minimum');
  assert.notEqual(toHex(feeInputsId({ ...base, role: 'game' })), was, 'the role');
  assert.notEqual(toHex(feeInputsId({ ...base, roundId: b32(9) })), was, 'the round');
  assert.notEqual(toHex(feeInputsId({ ...base, recordId: serviceRecordId(recordOf({ served: 21 })) })),
    was, 'the record');
});
