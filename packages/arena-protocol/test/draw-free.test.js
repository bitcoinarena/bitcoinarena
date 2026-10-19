// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2026.0.2 - THE ROUND CONTRACT THAT DOES NOT NAME ITS DRAW (RULED 2026-10-13, path 1). With 14 bonded nodes
// the testnet4 census could open no round: the draw is seeded by the round id, which hashed the `nodes` it had to name. A v2
// round's id hashes its contract with `nodes` emptied, both roles take one draw, and the seats write the seated 7 in.
import { test } from 'node:test';
import { SUPPORTED_PROTOCOL_VERSIONS as SPOKEN } from '../src/constants.js';
import assert from 'node:assert/strict';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import { seriesTemplate, seriesRound, seriesId, seriesRoundCheck, seriesIndexAt } from '../src/series.js';
import { selectCommittee } from '../src/sortition.js';
import { toHex } from '../src/hash.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const seven = Array.from({ length: 7 }, (_, i) => b32(0x40 + i));

test('a v2 round is written at version 2, names no nodes, and keeps its id when a seat writes its seated 7 in', () => {
  const v2 = { ...base, protocolVersion: 2 };
  const back = decodeRoundContract(encodeRoundContract(v2));
  assert.deepEqual([back.protocolVersion, back.nodes.length], [2, 0]);
  const seated = { ...back, nodes: seven };
  assert.equal(toHex(roundId(seated)), toHex(roundId(back)), 'the seated nodes are no input to the id');
  assert.equal(toHex(roundId(decodeRoundContract(encodeRoundContract(seated)))), toHex(roundId(v2)));
  // a v1 round is unchanged: its nodes are in its id
  const v1 = { ...base, nodes: seven };
  assert.equal(decodeRoundContract(encodeRoundContract(v1)).protocolVersion, 1);
  assert.notEqual(toHex(roundId(v1)), toHex(roundId({ ...v1, nodes: seven.slice(0, 6) })));
  // 4 is 2026.0.4 (top-N prize splits), 5 is 2026.0.5 (the median of signed readings), 6 is 2026.0.6
  // (markets on games, feature 6) and 7 is 2026.0.7 (scalar markets, feature 8), spoken; 8 is not
  assert.throws(() => encodeRoundContract({ ...base, protocolVersion: Math.max(...SPOKEN) + 1 }), new RegExp(`protocol version ${Math.max(...SPOKEN) + 1}`));
});

test('a v2 series: its id and its rounds\' ids ignore nodes, and a round with its seats written in is still the series\' round', () => {
  const T = seriesTemplate({ ...base, protocolVersion: 2, startTimeMs: 0n, entryCloseMs: 0n }, seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000));
  assert.equal(toHex(seriesId({ ...T, nodes: seven })), toHex(seriesId(T)));
  const r = seriesRound(T, 3);
  const withSeats = { ...decodeRoundContract(encodeRoundContract(r)), nodes: seven };
  assert.equal(toHex(roundId(withSeats)), toHex(roundId(r)));
  assert.equal(seriesRoundCheck(withSeats, [T]).ok, true);
});

test('fourteen nodes: a v2 round draws ONE ordered list for both roles - the seats of both are one set of 7; v1 draws two', () => {
  const entries = Array.from({ length: 14 }, (_, i) => ({ txid: b32(0x80 + i), vout: 0, pubkey: b32(0x10 + i), bondSats: 50000n, height: 1,
    hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false }));
  let differV1 = 0;
  for (let s = 0; s < 50; s++) {
    const seed = b32(s);
    const draw = (c, role) => selectCommittee({ entries, contract: c, role, committeeSeed: seed, count: 9 }).map((e) => toHex(e.pubkey)).join();
    const v2 = { ...base, protocolVersion: 2 };
    assert.equal(draw(v2, 'game'), draw(v2, 'settlement'));
    if (draw(base, 'game') !== draw(base, 'settlement')) differV1++;
  }
  assert.ok(differV1 > 40, `v1 draws differ by role (${differV1} of 50)`);
});
