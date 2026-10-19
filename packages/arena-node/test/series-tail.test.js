// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 82 s TAIL OF A DAY (the 82/90 fork, 2026-10-01, accepted): a node holds a day's series cut at round 360 (the
// old core, 10800 ticks) and its tail from 360 (the new core, 4920 ticks, 600 rounds, committee 12 h before its first round).
// Across the cut the announcement is 90 s start to start with no gap and no double: rounds before 360 are the series',
// from 360 the tail's at 4920; the series' own round 400 is refused at the round door by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, TRUCK_BEFORE_FORK_HASH } from '../../nextblock/plugin/nextblock.js';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_TESTNET4 } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { seriesTemplate, seriesIndexAt, seriesRound, seriesLeadIsValid } from '../../arena-protocol/src/series.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = (nodes) => ({
  // the pre-fork core's rounds name the founding config (2026-10-04: a round names the config of the rules it plays)
  networkId: NETWORK_ID_TESTNET4, configHash: GENESIS_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(TRUCK_BEFORE_FORK_HASH), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_TESTNET4.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n,
  bondMinSats: 50000n, blockTicks: 10800, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a day cut at 360 and its 82 s tail: the announcement runs on 90 s with no gap across the cut, the cut rounds are refused', async () => {
  const probe = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [probe.round.pubkey, b32(8)]; await probe.close();
  const k = seriesIndexAt(NETWORK_ID_TESTNET4, Date.UTC(2026, 9, 2));
  const day = { ...seriesTemplate(base(nodes), k), seriesCutFrom: 360 };
  const first = seriesRound(day, 360).startTimeMs;
  const tail = { ...day, seriesCutFrom: undefined, seriesCount: 600, startTimeMs: first, entryCloseMs: first, committeeTimeMs: first - 12n * 3600000n,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH, blockTicks: 4920 };
  delete tail.seriesCutFrom;
  assert.equal(seriesLeadIsValid(tail).ok, true, seriesLeadIsValid(tail).why);
  const NOW = Number(first) - 20 * 60000;                       // 20 minutes before the cut
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [day, tail],
    donationSets: [TEST_DONATION_SET_TESTNET4] });
  try {
    const url = `http://127.0.0.1:${s.port}`;
    const rows = (await (await fetch(`${url}/rounds?ahead=${45 * 60000}`)).json()).rounds
      .sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    const starts = rows.map((r) => Date.parse(r.startTime));
    const gaps = starts.slice(1).map((t, i) => (t - starts[i]) / 1000);
    const before = rows.filter((r) => Date.parse(r.startTime) < Number(first));
    const after = rows.filter((r) => Date.parse(r.startTime) >= Number(first));
    console.log('  FACTS (tail):', JSON.stringify({ rows: rows.length, gaps: [...new Set(gaps)], before: [...new Set(before.map((r) => r.blockTicks))],
      after: [...new Set(after.map((r) => r.blockTicks))], firstTail: after[0] && after[0].startTime }));
    assert.deepEqual([...new Set(gaps)], [90], 'the announcement is not 90 s start to start across the cut');
    assert.deepEqual([...new Set(before.map((r) => r.blockTicks))], [10800]);
    assert.deepEqual([...new Set(after.map((r) => r.blockTicks))], [4920], 'a cut round of the day was announced beside its tail');
    assert.equal(after[0].startTime, new Date(Number(first)).toISOString());
    // THE DAY'S OWN ROUND 400, POSTED: refused at the round door by name.
    const r = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(seriesRound(day, 400)) });
    assert.equal(r.status, 409);
    assert.match(await r.text(), /round 400 of series [0-9a-f]+ is replaced from index 360 by its 82 s tail/);
  } finally { await s.close(); }
});
