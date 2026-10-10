// A MARKET'S SERIES ON ITS OWN PERIOD (kanban #236/#237, §0A.7b.4: "Market rounds on their own 15 min period instead of the
// 90 s grid"): the paid lobby offers only rounds of a published series, and a series ran only on the 90 s grid - so the
// 15-minute Up/Down market could have no paid round. A series now runs on its market's round_period: 96 rounds a day, each
// on the quarter hour, written by the node like any series round; every 90 s series is exactly what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seriesWriter } from '../src/series-writer.js';
import { NEXTBLOCK, NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN } from './plugins/updown/index.js';
import { roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { seriesPeriodFits } from '../../arena-protocol/src/manifest.js';
import { seriesTemplate, seriesId, seriesRound, seriesRoundCheck, seriesIndexAt, roundsPerSeries, ROUNDS_PER_SERIES } from '../../arena-protocol/src/series.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const Q = 900000n;
const contract = (over) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 600, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 0, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7)], ...over,
});

test('the Up/Down market\'s series runs every 15 minutes: 96 rounds a day, written by the node, each its series\' own round', () => {
  assert.deepEqual(seriesPeriodFits(UPDOWN.registration.manifest), { ok: true, periodMs: Q }, 'a market runs on its own round_period');
  assert.equal(roundsPerSeries(Q), 96);
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW + 73 * 3600000);
  const t = seriesTemplate(contract(), k);
  const at90 = seriesId(t);
  const round = new Round(openStore(), () => NOW, { plugins: [NEXTBLOCK, UPDOWN.registration] });
  const w = seriesWriter(round, t);
  assert.equal(t.seriesPeriodMs, Q, 'the writer stamps the market\'s period on the template');
  assert.notDeepEqual(w.id, at90, 'a 15-minute series is another series than the same template on 90 s');
  assert.deepEqual(w.id, seriesId(t, { periodMs: Q, count: 96 }));
  // every round of its first day that starts inside the 72 h horizon: here the whole day, 96 rounds
  const added = w.write(Number(t.startTimeMs) - 3600000);
  assert.equal(added, 96);
  const r = seriesRound(t, 5);
  assert.equal(r.startTimeMs, t.startTimeMs + 5n * Q, 'round 5 starts 75 minutes after the series');
  assert.equal(Number(r.startTimeMs % Q), 0, 'on the UTC quarter hour');
  assert.ok(w.ids().has(toHex(roundIdOf(r))), 'the node wrote round 5 as its series derives it');
  assert.equal(seriesRoundCheck(r, [t]).ok, true);
  assert.throws(() => seriesRound(t, 96), /outside the series' 0 .. 95/);
});

test('a game\'s series stays on the 90 s grid: same id, same 960 rounds, a game naming another period still refused', () => {
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW + 73 * 3600000);
  const t = seriesTemplate(contract({ gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH, minScore: 1 }), k);
  const before = seriesId(t, { periodMs: 90000n, count: 960 });
  const round = new Round(openStore(), () => NOW, { plugins: [NEXTBLOCK, UPDOWN.registration] });
  const w = seriesWriter(round, t);
  assert.equal(t.seriesPeriodMs, undefined, 'nothing stamped on a 90 s game\'s template');
  assert.deepEqual(w.id, before, 'its id is the one it always had');
  assert.equal(ROUNDS_PER_SERIES, 960);
  assert.deepEqual(seriesPeriodFits({ ...NEXTBLOCK.manifest, roundPeriodMs: 60000n }).ok, false);
});
