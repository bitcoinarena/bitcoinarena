// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CUSTODY FIELD HAS ONE VALUE, AND BYTE 0 IS NOT IT (RULED 2026-09-22 22:59, §23.6).
//
// "THRESHOLD_LN does not exist, past rounds included, no decode-only value ... A round that names
// anything else is invalid, PAST ROUNDS INCLUDED: a record from before this ruling that carries the
// old value is not a round of this network ... a node that holds such a record treats it as it treats
// bytes that do not parse."
//
// The wire form is still an index: `custody` is `CUSTODY[byte]`. FEDERATION keeps byte 1 and is never
// renumbered onto the freed byte - if it were, every record written under the old byte 0 would decode,
// silently, as FEDERATION, which is the one outcome the ruling forbids by name. So byte 0 is a hole:
// encoding the old name throws, and decoding a record that carries byte 0 throws, exactly as a bad
// length throws. No label, no null, no flag a caller could choose to ignore.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CUSTODY, CUSTODY_VALUES, custodyByte } from '../src/constants.js';
import { encodeRoundContract, decodeRoundContract } from '../src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
  exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
  timeFloor: 16384, timeCeil: 98304, minScore: 1,
  rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4), b32(7), b32(9)],
});

// Where the custody byte sits: the wire writes custody, then federation_id, so it is the byte just
// before the federation_id - found in the encoding, not assumed from a hand count of offsets.
const custodyOffset = (bytes) => {
  const hex = Buffer.from(bytes).toString('hex');
  const fed = hex.indexOf(Buffer.from(TEST_FEDERATION_ID).toString('hex'));
  assert.ok(fed > 0 && fed % 2 === 0, 'the federation_id is not in the encoding');
  return fed / 2 - 1;
};

test('FEDERATION is byte 1, byte 0 is not a value, and FEDERATION is the only value', () => {
  const facts = { at0: CUSTODY[0], at1: CUSTODY[1], values: CUSTODY_VALUES, federation: custodyByte('FEDERATION') };
  console.log('  FACTS (the custody byte):', JSON.stringify(facts));
  assert.deepEqual(facts, { at0: undefined, at1: 'FEDERATION', values: ['FEDERATION'], federation: 1 });
  assert.equal(CUSTODY.length, 2, 'something was put after FEDERATION');
});

test('the withdrawn name cannot be encoded: it throws, and nothing is written', () => {
  assert.throws(() => custodyByte('THRESHOLD_LN'), /THRESHOLD_LN is not a custody this network has: the one value is FEDERATION/);
  assert.throws(() => encodeRoundContract({ ...sample(), custody: 'THRESHOLD_LN' }),
    /THRESHOLD_LN is not a custody this network has/);
  // byte 0 holds `undefined`, so neither a missing custody nor an explicit undefined may land on it
  assert.throws(() => custodyByte(undefined), /is not a custody this network has/);
  assert.throws(() => encodeRoundContract({ ...sample(), custody: undefined }), /is not a custody this network has/);
});

test('a record that carries byte 0 does not parse: it throws, it is not read as FEDERATION', () => {
  const fed = encodeRoundContract(sample());
  const at = custodyOffset(fed);
  assert.equal(fed[at], 1, 'the custody byte of a FEDERATION record is not 1');
  assert.equal(decodeRoundContract(fed).custody, 'FEDERATION');

  const old = Uint8Array.from(fed);
  old[at] = 0; // what every record written before the ruling under the withdrawn custody carries here
  assert.throws(() => decodeRoundContract(old), /custody byte 0 is not a custody of this network: the one value is FEDERATION/);

  const unknown = Uint8Array.from(fed);
  unknown[at] = 2;
  assert.throws(() => decodeRoundContract(unknown), /custody byte 2 is not a custody of this network/);
});

// NO LABEL IN THE THROW EITHER (RULED 2026-09-24, the enum slice's second cut): byte 0 throws the sentence byte 2
// throws, with only the digit changed. A message that named what byte 0 once was would be the decode-only label.
test('decoding byte 0 and byte 2 throws one sentence, only the digit changed, and neither names the withdrawn custody', () => {
  const fed = encodeRoundContract(sample());
  const at = custodyOffset(fed);
  const thrown = (b) => { const x = Uint8Array.from(fed); x[at] = b; try { decodeRoundContract(x); } catch (e) { return e.message; } return null; };
  const [zero, two] = [thrown(0), thrown(2)];
  console.log('  FACTS:', JSON.stringify({ zero, two }));
  assert.equal(zero, 'custody byte 0 is not a custody of this network: the one value is FEDERATION');
  assert.equal(two, zero.replace('byte 0', 'byte 2'), 'byte 0 and byte 2 do not throw one sentence');
  for (const m of [zero, two]) assert.equal(m.includes('THRESHOLD_LN'), false, `the throw names the withdrawn custody: ${m}`);
});
