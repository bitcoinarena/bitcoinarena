// THE NODE WRITES AND LISTS EVERY ROUND OF THE NEXT 72 HOURS (the owner 2026-09-28 11:31, NODE72-1131 / HORIZON72-1131).
//
// Three consecutive series - a series lasts 24 h - on one node with a fixed clock: every 90 s round from now to
// now + 72 h is in the node's store, the one about 72 h out among them, and /rounds?ahead=72h lists it; a lobby's plain
// /rounds sees the next ten minutes of them. A series that leaves less than the 72 h lead is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId } from '../../protocol/src/donation.js';
import {
  seriesTemplate, seriesId, seriesRound, seriesRoundsWithin, seriesLeadIsValid, seriesPublicationPayload,
  ROUND_PERIOD_MS, SERIES_MAX_MS, SERIES_LEAD_MIN_MS, ROUNDS_PER_SERIES, SERIES_CLOCKS, seriesClockFor, SERIES_WRITE_AHEAD_MS,
} from '../../protocol/src/series.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const H = 3600000;

const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a series: 960 rounds 90 s apart, each closing entry at its start, and its publication is "BLW" S + its id', () => {
  const t = seriesTemplate(base([b32(7)]), BigInt(NOW) + 100n * BigInt(H));
  assert.equal(ROUNDS_PER_SERIES, 960);
  assert.equal(t.startTimeMs - t.committeeTimeMs, 72n * BigInt(H), 'mainnet (and regtest): committee_time = series_start - 72 h (CENSUS3D-1401)');
  assert.deepEqual(seriesLeadIsValid(t).ok, true);
  const r5 = seriesRound(t, 5);
  assert.equal(r5.startTimeMs, t.startTimeMs + 5n * ROUND_PERIOD_MS);
  assert.equal(r5.entryCloseMs, r5.startTimeMs, 'no late join');
  assert.throws(() => seriesRound(t, 960), /outside the series/);
  assert.deepEqual(seriesRoundsWithin(t, t.startTimeMs - 1000n, t.startTimeMs + 180000n), [0, 1, 2]);
  const p = seriesPublicationPayload(seriesId(t));
  assert.deepEqual([...p.subarray(0, 4)], [0x42, 0x4c, 0x57, 0x53]);
  assert.equal(p.length, 36);
  const moved = seriesTemplate(base([b32(7)]), t.startTimeMs + ROUND_PERIOD_MS);
  assert.notDeepEqual(seriesId(moved), seriesId(t), 'another start is another series');
});

test('the node writes every round of the next 72 hours, the one 72 h out among them, and lists it', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW });
  const nodes = [node.round.pubkey];
  await node.close();
  // three consecutive series from an hour from now: 72 h of rounds needs three 24 h series
  const firstStart = BigInt(NOW) + BigInt(H);
  const series = [0n, 1n, 2n].map((k) => seriesTemplate(base(nodes), firstStart + k * SERIES_MAX_MS));
  const t0 = Date.now();
  const s = await serve(openStore(':memory:'), { port: 0, funded: () => true, roundClock: () => NOW, series });
  const tookMs = Date.now() - t0;
  try {
    const expected = series.reduce((n, t) => n + seriesRoundsWithin(t, BigInt(NOW), BigInt(NOW) + SERIES_LEAD_MIN_MS).length, 0);
    const summary = await (await fetch(`http://127.0.0.1:${s.port}/series`)).json();
    const written = summary.series.reduce((n, x) => n + x.written, 0);
    assert.equal(written, expected);
    const last = summary.series[2].last;
    const lastStart = BigInt(last.startTimeMs);
    assert.ok(lastStart <= BigInt(NOW) + SERIES_LEAD_MIN_MS && lastStart > BigInt(NOW) + SERIES_LEAD_MIN_MS - ROUND_PERIOD_MS,
      `the last written round starts within 90 s of now + 72 h, not at ${lastStart - BigInt(NOW)} ms`);
    const held = s.round.get(Buffer.from(last.id, 'hex'));
    assert.ok(held, 'the round 72 h out is in the node\'s store');
    const c = decodeRoundContract(new Uint8Array(held.contract));
    assert.equal(c.startTimeMs, lastStart);
    assert.equal(c.entryCloseMs, c.startTimeMs);

    const all = await (await fetch(`http://127.0.0.1:${s.port}/rounds?ahead=72h`)).json();
    assert.equal(all.rounds.length, written, 'every written round is listed out to 72 h');
    assert.ok(all.rounds.some((r) => r.id === last.id), 'the round 72 h out is listed');
    const lobby = await (await fetch(`http://127.0.0.1:${s.port}/rounds`)).json();
    assert.ok(lobby.rounds.every((r) => BigInt(r.startTimeMs) <= BigInt(NOW) + 600000n), 'a plain /rounds lists the next ten minutes of a series');
    console.log(`  FACTS: ${JSON.stringify({ written, perSeries: summary.series.map((x) => x.written), last: { index: last.index,
      inHours: Number(lastStart - BigInt(NOW)) / H, id: last.id.slice(0, 16) }, listedAt72h: all.rounds.length, lobbyListed: lobby.rounds.length, tookMs })}`);
  } finally { await s.close(); }
});

test('a series with less than the 72 h lead is refused whole, by name', async () => {
  const t = seriesTemplate(base([b32(7)]), BigInt(NOW) + BigInt(H));
  const short = { ...t, committeeTimeMs: t.startTimeMs - 48n * BigInt(H) };        // the 48 h this morning ruled out
  assert.match(seriesLeadIsValid(short).why, /must exist 259200000 ms \(72 h\) before its first entry/);
  await assert.rejects(async () => serve(openStore(':memory:'), { port: 0, funded: () => true, roundClock: () => NOW, series: [short] }), /series refused/);
});

// TN24-1405 AND THE 36 h CENSUS (the owner 2026-09-28): testnet4's committee_time is 24 h before the start and its lead 24 h,
// its census 36 h before the start - 12 h before committee_time, the publication window; mainnet stays one 72 h; the
// writer lays 72 h of rounds ahead on both.
test('testnet4 runs a 24 h committee clock on a 36 h census, mainnet one 72 h, and the writer 72 h on both', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SERIES_CLOCKS.mainnet).map(([k, v]) => [k, Number(v) / H])),
    { censusLeadMs: 72, committeeLeadMs: 72, leadMinMs: 72 });
  assert.deepEqual(Object.fromEntries(Object.entries(SERIES_CLOCKS.testnet4).map(([k, v]) => [k, Number(v) / H])),
    { censusLeadMs: 36, committeeLeadMs: 24, leadMinMs: 24 });
  assert.equal(seriesClockFor(NETWORK_ID_REGTEST), SERIES_CLOCKS.mainnet);
  assert.equal(seriesClockFor(NETWORK_ID_TESTNET4), SERIES_CLOCKS.testnet4);
  assert.equal(Number(SERIES_WRITE_AHEAD_MS) / H, 72);
  // census 154206, median 2026-09-28T07:52:04Z: series_start = MTP + 36 h + 1 s, committee_time 12 h after the census
  const mtp = BigInt(Date.parse('2026-09-28T07:52:04Z'));
  const tn = { ...base([b32(7)]), networkId: NETWORK_ID_TESTNET4 };
  const t = seriesTemplate(tn, mtp + SERIES_CLOCKS.testnet4.censusLeadMs + 1000n);
  assert.equal(new Date(Number(t.startTimeMs)).toISOString(), '2026-09-29T19:52:05.000Z');
  assert.equal(new Date(Number(t.committeeTimeMs)).toISOString(), '2026-09-28T19:52:05.000Z');
  assert.equal(t.committeeTimeMs - mtp, 12n * BigInt(H) + 1000n, 'committee_time 12 h after the census median, not 1 s');
  assert.equal(seriesLeadIsValid(t).ok, true);
  assert.equal(seriesLeadIsValid({ ...t, committeeTimeMs: t.startTimeMs - 23n * BigInt(H) }).ok, false, 'testnet4 refuses under 24 h');
  // the 3 October series keeps its 84 h lead and stays valid on testnet4
  assert.equal(seriesLeadIsValid({ ...t, committeeTimeMs: t.startTimeMs - 84n * BigInt(H) }).ok, true);
  // the writer on testnet4: 72 h of rounds ahead, not 24
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const nodes = [node.round.pubkey]; await node.close();
  const series = [0n, 1n, 2n].map((k) => seriesTemplate({ ...base(nodes), networkId: NETWORK_ID_TESTNET4 }, BigInt(NOW) + BigInt(H) + k * SERIES_MAX_MS));
  const s = await serve(openStore(':memory:'), { port: 0, funded: () => true, roundClock: () => NOW, series });
  try {
    const sum = await (await fetch(`http://127.0.0.1:${s.port}/series`)).json();
    const last = BigInt(sum.series[2].last.startTimeMs);
    assert.ok(last > BigInt(NOW) + 72n * BigInt(H) - ROUND_PERIOD_MS && last <= BigInt(NOW) + 72n * BigInt(H), 'testnet4 rounds written 72 h ahead');
    console.log(`  FACTS: testnet4 written ${sum.series.reduce((n, x) => n + x.written, 0)}, last ${(Number(last) - NOW) / H} h out`);
  } finally { await s.close(); }
});
