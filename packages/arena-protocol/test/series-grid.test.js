// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GRID SERIES (2026-10-12, S: an RPS grid published as one short series per table): lead >= 45 min,
// any start, at most 24 h of rounds (2026-10-12 ~09:55Z; 30 min before), its own entry window; `grid`, period and count in its id; every round derived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesRound, seriesLeadIsValid, seriesId, seriesRoundCheck, findSeriesPublication, seriesPublicationOutput,
  GRID_SERIES_LEAD_MIN_MS, GRID_SERIES_MAX_MS } from '../src/series.js';
import { roundId, encodeRoundContract } from '../src/contracts.js';
import { NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { serializeSpend } from '../src/bond-spend.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791800000123n;                              // any start: not on the 90 s grid, not on a day
const grid = (over = {}) => ({ networkId: NETWORK_ID_TESTNET4, configHash: b32(1), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(3), committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: START, entryCloseMs: START + 80000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: b32(4), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(5), censusHeight: 156186, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30,
  timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(9)],
  seriesGrid: true, seriesPeriodMs: 8000n, seriesCount: 225, ...over });

test('a grid is valid with 45 min of lead, any start, up to 24 h of rounds and its own entry window - and refused short of any', () => {
  const ok = seriesLeadIsValid(grid());
  assert.deepEqual([ok.ok, ok.grid, ok.leadMs], [true, true, GRID_SERIES_LEAD_MIN_MS]);
  assert.equal(10800n * 8000n, GRID_SERIES_MAX_MS);
  assert.match(seriesLeadIsValid(grid({ committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS + 1n })).why, /a grid needs 2700000 ms \(45 min\)/);
  assert.equal(seriesLeadIsValid(grid({ seriesCount: 10800 })).ok, true, '24 h of 8 s slots');
  assert.match(seriesLeadIsValid(grid({ seriesCount: 10801 })).why, /runs 86408000 ms, and a grid runs at most 86400000 ms \(24 h\)/);
  assert.match(seriesLeadIsValid(grid({ seriesPeriodMs: undefined })).why, /names its period/);
  assert.match(seriesLeadIsValid(grid({ seriesCount: undefined })).why, /names its round count/);
  assert.match(seriesLeadIsValid(grid({ entryCloseMs: START - 1n })).why, /closes at or after its start/);
  // THE SAME TEMPLATE WITHOUT `grid` is a day series, held to the 24 h lead on testnet4
  assert.equal(seriesLeadIsValid(grid({ seriesGrid: undefined })).ok, false);
});

test('a grid\'s id carries grid, period and count; its rounds are derived 8 s apart with its own 80 s entry window', () => {
  const t = grid();
  const hex = (b) => Buffer.from(b).toString('hex');
  const id = hex(seriesId(t));
  assert.notEqual(id, hex(seriesId({ ...t, seriesGrid: undefined })));
  assert.notEqual(id, hex(seriesId({ ...t, seriesCount: 224 })));
  assert.notEqual(id, hex(seriesId({ ...t, seriesPeriodMs: 9000n })));
  const r0 = seriesRound(t, 0), r224 = seriesRound(t, 224);
  assert.deepEqual([r0.startTimeMs, r0.entryCloseMs, r0.committeeTimeMs], [START, START + 80000n, t.committeeTimeMs]);
  assert.deepEqual([r224.startTimeMs, r224.entryCloseMs], [START + 224n * 8000n, START + 224n * 8000n + 80000n]);
  assert.equal(hex(r0.seriesId), id);
  assert.throws(() => seriesRound(t, 225), /outside the series' 0 \.\. 224/);
  // ITS ID IS H(series_id || i), and a seat holding the grid takes exactly the derived round
  assert.notEqual(hex(roundId(seriesRound(t, 7))), hex(roundId({ ...seriesRound(t, 7), seriesId: undefined, roundIndex: undefined })));
  assert.equal(seriesRoundCheck(seriesRound(t, 7), [t]).ok, true);
  assert.match(seriesRoundCheck({ ...seriesRound(t, 7), entryCloseMs: seriesRound(t, 7).entryCloseMs + 1n }, [t]).why, /opens and closes its entry at/);
  assert.match(seriesRoundCheck({ ...seriesRound(t, 7), stakeMsat: 1n }, [t]).why, /not round 7 of series/);
  assert.equal(encodeRoundContract(seriesRound(t, 7)).length > 0, true);
});

test('two tables, one transaction: each table\'s "ARN" SERIES output is found where it confirmed', () => {
  const t0 = grid(), t1 = grid({ committeeTimeMs: grid().committeeTimeMs - 1n });
  const tx = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(7), vout: 0, sequence: 0xfffffffd }],
    outputs: [seriesPublicationOutput(seriesId(t0)), seriesPublicationOutput(seriesId(t1))], witnesses: [[]] });
  const view = { firstHeight: 156200, blocks: [{ transactions: [] }, { transactions: [tx] }] };
  assert.equal(findSeriesPublication(view, seriesId(t0)).height, 156201);
  assert.equal(findSeriesPublication(view, seriesId(t1)).height, 156201);
  assert.equal(findSeriesPublication(view, seriesId({ ...t1, seriesCount: 224 })), null);
  assert.equal(seriesPublicationOutput(seriesId(t0)).script.length, 38);
});
