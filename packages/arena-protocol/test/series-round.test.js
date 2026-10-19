// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND OF A SERIES IS DERIVED, NEVER AUTHORED (ALL-BUT-MIN-1727, 2026-09-29 17:27): it carries its series id
// and its index, its id is round_id(i) = H(series_id || i), and a round the series does not derive is refused by name.
// A series starts at its network's genesis_series_start + k * 24 h and never where it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import { seriesTemplate, seriesRound, seriesId, seriesRoundCheck, seriesStartOf, seriesIndexAt, seriesLeadIsValid,
  ROUNDS_PER_SERIES, SERIES_MAX_MS } from '../src/series.js';
import { genesisFor, GENESIS_SERIES_START_MS } from '../src/genesis.js';
import { taggedHash, toHex } from '../src/hash.js';
import { TAG } from '../src/constants.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)],
};
const K = seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000);
const T = seriesTemplate(base, K);

test('genesis_series_start is a genesis parameter: series k starts there + k * 24 h, and a moved start is refused', () => {
  assert.equal(genesisFor('regtest').genesisSeriesStartMs, GENESIS_SERIES_START_MS.regtest);
  assert.equal(genesisFor('testnet4').genesisSeriesStartMs, GENESIS_SERIES_START_MS.testnet4);
  assert.equal(seriesStartOf(NETWORK_ID_TESTNET4, 0), GENESIS_SERIES_START_MS.testnet4);
  assert.equal(T.startTimeMs, GENESIS_SERIES_START_MS.regtest + BigInt(K) * SERIES_MAX_MS);
  assert.equal(seriesLeadIsValid(T).ok, true);
  const off = { ...T, startTimeMs: T.startTimeMs + 1000n, entryCloseMs: T.startTimeMs + 1000n, committeeTimeMs: T.committeeTimeMs + 1000n };
  assert.equal(seriesLeadIsValid(off).ok, false);
  assert.match(seriesLeadIsValid(off).why, /genesis_series_start/);
});

test('round i of a series carries its series id and index, and its id is H(series_id || i)', () => {
  const r = seriesRound(T, 7);
  assert.deepEqual(r.seriesId, seriesId(T));
  assert.equal(r.roundIndex, 7);
  const i = new Uint8Array(4); new DataView(i.buffer).setUint32(0, 7, false);
  const body = new Uint8Array(36); body.set(seriesId(T), 0); body.set(i, 32);
  assert.equal(toHex(roundId(r)), toHex(taggedHash(TAG.seriesRound, body)));
  const back = decodeRoundContract(encodeRoundContract(r));
  assert.deepEqual(back.seriesId, r.seriesId);
  assert.equal(back.roundIndex, 7);
  assert.equal(toHex(roundId(back)), toHex(roundId(r)));
  // two rounds of one series differ by their index alone
  assert.notEqual(toHex(roundId(seriesRound(T, 8))), toHex(roundId(r)));
});

test('a round that names no series keeps its bytes and its id', () => {
  const plain = { ...base, startTimeMs: 1n, entryCloseMs: 2n, committeeTimeMs: 0n };
  const bytes = encodeRoundContract(plain);
  assert.equal(toHex(roundId(plain)), toHex(taggedHash(TAG.roundContract, bytes)));
  assert.equal(decodeRoundContract(bytes).seriesId, undefined);
  assert.throws(() => decodeRoundContract(new Uint8Array([...bytes, 1, 2, 3])), /trailing bytes/);
  assert.throws(() => encodeRoundContract({ ...plain, roundIndex: 3 }), /without its series/);
});

test('the check takes only the round the series derives - another series, an index out of range, a moved window, any other field', () => {
  const held = [T];
  assert.deepEqual(seriesRoundCheck({ ...base, startTimeMs: 1n, entryCloseMs: 2n }, held), { ok: true, series: false });
  const r = seriesRound(T, 959);
  assert.equal(seriesRoundCheck(r, held).ok, true, 'the last round, 959, is the series\' own');
  const other = seriesRound(seriesTemplate(base, K + 1), 3);
  assert.match(seriesRoundCheck(other, held).why, /this node holds no such series/);
  assert.match(seriesRoundCheck({ ...r, roundIndex: ROUNDS_PER_SERIES }, held).why, /outside series .*0 \.\. 959/);
  assert.match(seriesRoundCheck({ ...r, entryCloseMs: r.entryCloseMs + 1000n }, held).why, /opens and closes its entry/);
  assert.match(seriesRoundCheck({ ...r, stakeMsat: 10000000n }, held).why, /not round 959 of series .* as the series derives it/);
});
