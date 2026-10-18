// THE GUARDIAN THIRD GOES TO THE FEDERATION'S SEATED GUARDIANS (§22A v4.6.4, kanban #33 gap 1). Measured on Tick Tock round 32cfad1c
// (2026-10-16, federation A 337ae01a, 7 guardians = test host seats 1-7, no absence, no departure): test host 7 was out of that day's census
// and got nothing, the six in it 278 msat each. From SEATED_GUARDIAN_VERSION the pool is the record's seated guardians - all seven -
// and a gone one is left out; below it, the census rule stands unchanged (the live rounds of versions 1-12 settle as before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianPoolOf } from '../src/roster.js';
import { seatedOf } from '../src/federation-records.js';
import { nodeFeeTable, GAME_VERIFY, SETTLEMENT, GUARDIAN } from '../../arena-protocol/src/fee.js';
import { SEATED_GUARDIAN_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';

const fid = new Uint8Array(32).fill(0x33);
const key = (n) => new Uint8Array(32).fill(n);
const peer = (n) => new Uint8Array(33).fill(n);
// census: test host 1-6 name federation A; test host 7 is not in it (stepped out); a second-host seat guards nothing
const census = { entries: [1, 2, 3, 4, 5, 6].map((n) => ({ pubkey: key(n), advert: { guardianOf: [{ federationId: fid, guardianKey: peer(n) }] } }))
  .concat([{ pubkey: key(20), advert: { guardianOf: [] } }]) };
// A's record: 7 guardians, none gone
const record = { guardians: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ peerKey: peer(n), nodePubkey: key(n) })), gone: [] };

test('below the version: the census nodes naming the federation; from it: the record\'s seated guardians, test host 7 included', () => {
  assert.equal(SEATED_GUARDIAN_VERSION, 13);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(13));
  const v12 = guardianPoolOf({ contract: { federationId: fid, protocolVersion: 12 }, census, seated: seatedOf(record) });
  assert.deepEqual(v12.map((k) => k[0]), [1, 2, 3, 4, 5, 6], 'v12: as 32cfad1c was paid');
  const v13 = guardianPoolOf({ contract: { federationId: fid, protocolVersion: 13 }, census, seated: seatedOf(record) });
  assert.deepEqual(v13.map((k) => k[0]), [1, 2, 3, 4, 5, 6, 7], 'v13: all seven seated guardians');
  const noRecord = guardianPoolOf({ contract: { federationId: fid, protocolVersion: 13 }, census, seated: null });
  assert.deepEqual(noRecord.map((k) => k[0]), [1, 2, 3, 4, 5, 6], 'no record held: the census rule');
  const drain = guardianPoolOf({ contract: { federationId: fid, protocolVersion: 13 }, census, seated: seatedOf(record), drain: [key(40)] });
  assert.equal(drain.length, 8, 'a draining predecessor\'s seated guardians after them, as before');
});

test('a gone guardian leaves the pool and its share goes to the seated ones; the 2 % / 5 % total does not move', () => {
  const gone = { ...record, gone: [{ peerKey: peer(3), sinceHeight: 156500, kind: 1 }] };
  const pool = guardianPoolOf({ contract: { federationId: fid, protocolVersion: 13 }, census, seated: seatedOf(gone) });
  assert.deepEqual(pool.map((k) => k[0]), [1, 2, 4, 5, 6, 7]);
  // a round's fee through the fee table with each pool (5 % of four 100,000 msat stakes): the guardian third over 7 seated, then 6
  const committee = [8, 9, 10, 11, 12, 13, 14].map(key);
  const contract = {
    networkId: key(0x4e), configHash: key(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: key(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
    custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: fid, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: key(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
    blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: committee,
  };
  const entries = [0xa1, 0xa2, 0xa3, 0xa4].map((n) => ({ pubkey: key(n), outcome: 'DELIVERED', score: 500, stakeMsat: 100000n }));
  const table = (guardians) => nodeFeeTable({ contract, entries, pools: { [GAME_VERIFY]: committee, [SETTLEMENT]: committee, [GUARDIAN]: guardians },
    eligible: new Set([...committee, ...guardians].map(toHex)) });
  const guardianShare = (t, n) => [...t.signerNodes.entries()].filter(([k]) => k.includes(GUARDIAN) && k.includes(toHex(key(n)))).reduce((a, [, v]) => a + v, 0n);
  const seven = table(seatedOf(record));
  const six = table(pool);
  assert.equal(seven.fee, six.fee, 'the fee does not move');
  assert.equal(seven.pools[GUARDIAN], six.pools[GUARDIAN], 'nor the guardian third');
  assert.ok(guardianShare(seven, 7) > 0n, 'test host 7 paid when seated');
  assert.equal(guardianShare(six, 3), 0n, 'the gone guardian unpaid');
  assert.ok(guardianShare(six, 1) > guardianShare(seven, 1), 'and the seated ones take its share');
  assert.equal(six.unallocated, 0n);
});
