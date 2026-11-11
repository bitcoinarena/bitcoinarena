// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1242 (ruling #1218 D, audit 3 #1210 FIXES-1): an invented round counted for the season - its committee was drawn on the contract the
// account carried, so two colluding bonded seats ground a 2-slot contract until the draw held both and signed it. A round now counts only as a
// held series' derived, paid slot (its publication checked below the beacon by the committee draw), with the standard 7 / 7 committees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonRoundStands } from '../src/season-stands.js';
import { seriesTemplate, seriesRound, seriesId, seriesIndexAt } from '../../arena-protocol/src/series.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2,
};
const T = seriesTemplate(base, seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000));
const SID = toHex(seriesId(T));
const held = { series: [T] };
const round3 = decodeRoundContract(encodeRoundContract(seriesRound(T, 3)));

test('#1242 a held series\' derived, paid 7 / 7 slot counts; a free series round (never published on chain) does not', () => {
  const ok = seasonRoundStands(round3, held);
  const FREE = seriesTemplate({ ...base, stakeMsat: 0n }, seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000));
  const free = seasonRoundStands(decodeRoundContract(encodeRoundContract(seriesRound(FREE, 3))), { series: [FREE] });
  console.log('  MEASURED #1242 derived:', JSON.stringify({ paidSlot: ok.ok, freeSlot: free.ok, why: free.why }));
  assert.equal(ok.ok, true, ok.why);
  assert.equal(free.ok, false); assert.match(free.why, /free round/);
});

test('#1242 the ground contracts do not count: 2 slots, a free field changed, no series at all', () => {
  const twoSlots = { ...round3, gameVerifySlots: 2, settlementSlots: 2 };
  const ground = { ...round3, exposureReference: 1001 };             // a free field varied until the draw held the colluders
  const noSeries = { ...round3, seriesId: undefined, roundIndex: undefined };
  const otherIndex = { ...round3, roundIndex: 4 };                   // the slot's fields under another index
  const facts = Object.fromEntries(Object.entries({ twoSlots, ground, noSeries, otherIndex }).map(([k, c]) => [k, seasonRoundStands(c, held)]));
  console.log('  MEASURED #1242 ground:', JSON.stringify(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.ok ? 'counts' : v.why.slice(0, 70)]))));
  for (const [k, v] of Object.entries(facts)) assert.equal(v.ok, false, `${k} counted for the season`);
  assert.match(facts.twoSlots.why, /7 game and 7 settlement/);
});

test('#1242 a round of a series taken out of the file still counts as that series derives it (pastSeries)', () => {
  const past = new Map([[SID, T]]);
  assert.equal(seasonRoundStands(round3, { series: [], pastSeries: past }).ok, true);
  assert.equal(seasonRoundStands(round3, { series: [] }).ok, false);
});
