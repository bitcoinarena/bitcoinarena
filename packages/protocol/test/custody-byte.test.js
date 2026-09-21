// THE CUSTODY BYTE IS AN INDEX, AND THAT IS WHY THRESHOLD_LN STAYS IN THE ARRAY.
//
// §23.6: "THRESHOLD_LN is withdrawn ... Rounds that ran under it are regtest
// history; the value stays defined only so that their records still decode, and
// no new round may carry it."
//
// The wire form is `custody: CUSTODY[r.u8()]` - the byte IS the position in the
// array. So removing the withdrawn label is not a tidy-up, it is a renumber:
// FEDERATION would move from byte 1 to byte 0, every historical record written
// as THRESHOLD_LN would read back as FEDERATION, and every federation record -
// including the seven-node settle this milestone measured - would read back as
// nothing at all. A silent reinterpretation of custody on money records is worse
// than a loud failure, so the mapping is pinned here.
//
// Nothing in this file says a new round may carry THRESHOLD_LN. Refusing that is
// the door's job and belongs with the hold-invoice stack's retirement; what is
// asserted here is only that the two bytes keep meaning what they have always
// meant.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CUSTODY, custodyByte } from '../src/constants.js';
import { encodeRoundContract, decodeRoundContract } from '../src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
  exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
  timeFloor: 16384, timeCeil: 98304, minScore: 1,
  rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4), b32(7), b32(9)],
});

test('byte 0 is THRESHOLD_LN and byte 1 is FEDERATION, and neither may move', () => {
  const facts = { at0: CUSTODY[0], at1: CUSTODY[1], threshold: custodyByte('THRESHOLD_LN'), federation: custodyByte('FEDERATION') };
  console.log('  FACTS (the custody byte):', JSON.stringify(facts));
  assert.deepEqual(facts, { at0: 'THRESHOLD_LN', at1: 'FEDERATION', threshold: 0, federation: 1 });
});

test('a record written under the withdrawn custody still reads back as that custody', () => {
  const history = encodeRoundContract({ ...sample(), custody: 'THRESHOLD_LN', federationId: new Uint8Array(32) });
  const read = decodeRoundContract(history);
  console.log('  FACTS (a regtest-history record):', JSON.stringify({ custody: read.custody }));
  // NOT 'FEDERATION'. If this ever reads FEDERATION, the array was renumbered and
  // every round that ran under the committee's own lnd now claims a federation
  // held its stake.
  assert.equal(read.custody, 'THRESHOLD_LN');
});

test('a federation record still reads back as FEDERATION, and not as the withdrawn one', () => {
  const fed = encodeRoundContract({ ...sample(), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID });
  const read = decodeRoundContract(fed);
  console.log('  FACTS (a federation record):', JSON.stringify({ custody: read.custody }));
  assert.equal(read.custody, 'FEDERATION');
  assert.notEqual(read.custody, undefined, 'a renumbered array reads byte 1 as nothing at all');
});
