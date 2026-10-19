// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TAIL SERIES (the 82/90 fork, 2026-10-01: "the partial-day tail"): testnet4 only, on the 90 s grid inside its day,
// running to that day's end (960 - its index rounds), a committee lead of at least 12 h; its id is taken over its count,
// and a series cut at an index takes no round from it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesTemplate, seriesIndexAt, seriesRound, seriesLeadIsValid, seriesId, seriesRoundCheck } from '../src/series.js';
import { NETWORK_ID_TESTNET4, NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = (networkId) => ({ networkId, configHash: b32(1), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(3),
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: b32(4), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(5),
  censusHeight: 154539, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(9)] });
const tailOf = (day, i, { count = 960 - i, leadH = 12n } = {}) => {
  const s = seriesRound(day, i).startTimeMs;
  return { ...day, seriesCount: count, startTimeMs: s, entryCloseMs: s, committeeTimeMs: s - leadH * 3600000n };
};

test('a tail is valid on testnet4 from a 90 s round of its day to the day\'s end with 12 h of lead - and nothing else is', () => {
  const day = seriesTemplate(base(NETWORK_ID_TESTNET4), seriesIndexAt(NETWORK_ID_TESTNET4, Date.UTC(2026, 9, 2)));
  const ok = seriesLeadIsValid(tailOf(day, 360));
  assert.deepEqual([ok.ok, ok.tail, ok.fromIndex], [true, true, 360]);
  assert.match(seriesLeadIsValid(tailOf(day, 360, { count: 599 })).why, /runs 600 rounds, to the day's end - not 599/);
  assert.match(seriesLeadIsValid(tailOf(day, 360, { leadH: 11n })).why, /a tail needs 43200000 ms \(12 h\)/);
  assert.match(seriesLeadIsValid({ ...tailOf(day, 360), startTimeMs: tailOf(day, 360).startTimeMs + 1000n, entryCloseMs: tailOf(day, 360).startTimeMs + 1000n }).why, /starts on the 90 s grid/);
  // any network but testnet4 runs the mainnet clock: regtest here
  const mainDay = seriesTemplate(base(NETWORK_ID_REGTEST), seriesIndexAt(NETWORK_ID_REGTEST, Date.UTC(2026, 9, 2)) + 3);
  assert.match(seriesLeadIsValid(tailOf(mainDay, 360)).why, /testnet4's only: the mainnet clock is one 72 h/);
  // ITS ID IS TAKEN OVER ITS COUNT; ITS ROUNDS ARE ITS OWN AND THE CUT DAY'S ROUNDS FROM 360 ARE REFUSED
  const tail = tailOf(day, 360);
  assert.notEqual(Buffer.from(seriesId(tail)).toString('hex'), Buffer.from(seriesId({ ...tail, seriesCount: undefined })).toString('hex'));
  const cut = { ...day, seriesCutFrom: 360 };
  assert.equal(seriesRoundCheck(seriesRound(tail, 0), [cut, tail]).ok, true);
  assert.equal(seriesRoundCheck(seriesRound(tail, 599), [cut, tail]).ok, true);
  assert.match(seriesRoundCheck(seriesRound(tail, 0), [cut, tail]).why || 'ok', /ok/);
  assert.equal(seriesRoundCheck(seriesRound(day, 359), [cut, tail]).ok, true);
  assert.match(seriesRoundCheck(seriesRound(day, 360), [cut, tail]).why, /round 360 of series [0-9a-f]+ is replaced from index 360 by its 82 s tail/);
});
