// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CLAIMING A FEE SHARE 22A DOES NOT ALLOW: REFUSED BY NAME (RULED 2026-11-02, kanban #1035, #1040). No node claims anything: shares
// come from the settlement plan, and a claim carries no signature, so these bytes prove nothing against anybody.
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  encodeFeeClaim, decodeFeeClaim, feeClaimId, encodeServiceRecord,
  decodeServiceRecord, serviceRecordId, feeInputsId, slashHoldsOnFeeClaim,
} from '../src/slash.js';
import { nodeFeeTable, feeTableId, feeOwed, GAME_VERIFY, SETTLEMENT } from '../src/fee.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

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
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: MINIMUM, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [NODE, b32(0x22)],
};

// 22A's table for this round: one activated stake of 400000 msat, so a fee of
// 5% (20000, §0A.8), half to each pool, and NODE the only eligible verify signer node - that half owed.
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

// WHAT SLASHED BEFORE THE RULING, BYTE FOR BYTE: a claim anybody can write, a record short, no signature of the accused.
test('an unsigned claim slashes nobody: refused by name', () => {
  const claim = claimOf(), record = recordOf({ served: MINIMUM - 1 });
  const no = slashHoldsOnFeeClaim({
    proof: proofFor(claim, record), signedClaim: encodeFeeClaim(claim),
    serviceRecord: encodeServiceRecord(record), contract, feeTable, advert, committee,
  });
  assert.equal(no.slashed, false);
  assert.equal(no.bond, undefined);
  assert.match(no.why, /refused: row 5/);
});

// Named for the message rather than the value.
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
