// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2026.0.3 - EVERY GAME THROUGH EVERY FEDERATION (2026-10-13 ~11:45Z: "Es muss möglich sein für alle Spiele über
// alle Federation zu zahlen"). A v3 paying round may name no single federation (a zero federation_id: any federation its seats hold
// OPEN); each entry then names the federation its locks are in, after its own marker, so every older entry keeps its bytes and id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, decodeEntryContract, entryId, custodyFieldsAreValid,
  FEDERATION_MARKER, COMMIT_MARKER } from '../src/contracts.js';
import { takesAnyFederation, SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { protocolVersionName } from '../src/protocol-version.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ZERO = new Uint8Array(32);
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const entry = {
  roundId: b32(9), playerPubkey: b32(1), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
  stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
};

test('version 3 is 2026.0.3 and spoken; a v3 paying round with a zero federation_id takes any federation, a v1/v2 one is refused', () => {
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(3));
  assert.equal(protocolVersionName(3), '3');
  const any = { ...round, protocolVersion: 3, federationId: ZERO };
  const back = decodeRoundContract(encodeRoundContract(any));
  assert.equal(back.protocolVersion, 3);
  assert.equal(takesAnyFederation(back), true);
  assert.equal(custodyFieldsAreValid(back).ok, true);
  for (const v of [1, 2]) assert.throws(() => encodeRoundContract({ ...round, protocolVersion: v, federationId: ZERO }), /names no federation_id/);
  // a v3 round naming one federation is still that federation's only
  assert.equal(takesAnyFederation(decodeRoundContract(encodeRoundContract({ ...round, protocolVersion: 3 }))), false);
  assert.notEqual(Buffer.from(roundId(any)).toString('hex'), Buffer.from(roundId({ ...any, protocolVersion: 2, federationId: TEST_FEDERATION_ID })).toString('hex'));
});

test('an entry names the federation its locks are in, last, after its marker; every other entry keeps its bytes and its id', () => {
  const plain = encodeEntryContract(entry);
  const fed = b32(0xfe);
  const named = encodeEntryContract({ ...entry, federationId: fed });
  assert.deepEqual(named.subarray(0, plain.length), plain, 'the older bytes first, unchanged');
  assert.equal(named[plain.length], FEDERATION_MARKER);
  assert.deepEqual(decodeEntryContract(named).federationId, fed);
  assert.equal(decodeEntryContract(plain).federationId, undefined);
  assert.notDeepEqual(entryId({ ...entry, federationId: fed }), entryId(entry));
  // with a pick and an order, with a move commitment, with donation outpoints: the federation still reads back
  for (const more of [{ pick: 1 }, { pick: 0, limitPrice: 6200, orderExpiryMs: 99n }, { commit: b32(0x33) }, { donationOutpoints: [{ txid: b32(0x0d), outIdx: 3n }] },
    { donationOutpoints: [{ txid: b32(0x0d), outIdx: 3n }], pick: 1, limitPrice: 1, orderExpiryMs: 0n }]) {
    const e = decodeEntryContract(encodeEntryContract({ ...entry, ...more, federationId: fed }));
    assert.deepEqual(e.federationId, fed, JSON.stringify(Object.keys(more)));
    if (more.pick !== undefined) assert.equal(e.pick, more.pick);
    if (more.limitPrice !== undefined) assert.equal(e.limitPrice, more.limitPrice);
    if (more.commit) assert.deepEqual(e.commit, more.commit);
  }
  assert.throws(() => encodeEntryContract({ ...entry, federationId: ZERO }), /not zero/);
  const zeroed = Uint8Array.from([...plain, FEDERATION_MARKER, ...ZERO]);
  assert.throws(() => decodeEntryContract(zeroed), /not zero/);
  const stray = Uint8Array.from([...plain, COMMIT_MARKER, ...b32(1), 0x01]);
  assert.throws(() => decodeEntryContract(stray), /neither its federation, its operator, its website, its items, its reserve lock nor the bot mark/);
});

test('the federation an entry\'s locks are in: its own on a round that takes any (none named is refused), else the round\'s', async () => {
  const { entryFederation } = await import('../src/contracts.js');
  const any = { ...round, protocolVersion: 3, federationId: ZERO };
  const one = { ...round, protocolVersion: 3 };
  const fed = b32(0xfe);
  assert.deepEqual(entryFederation(any, { ...entry, federationId: fed }), { ok: true, federationId: fed });
  assert.match(entryFederation(any, entry).why, /names none/);
  assert.deepEqual(entryFederation(one, entry).federationId, TEST_FEDERATION_ID, 'a one-federation round: its own');
  assert.deepEqual(entryFederation(one, { ...entry, federationId: TEST_FEDERATION_ID }).federationId, TEST_FEDERATION_ID, 'naming the same is fine');
  assert.match(entryFederation(one, { ...entry, federationId: fed }).why, /another federation than its round's/);
  assert.match(entryFederation({ ...round, protocolVersion: 2, federationId: ZERO }, entry).why, /names no federation/);
});
