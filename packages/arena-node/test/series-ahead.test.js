// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE WRITES AND LISTS EVERY ROUND OF THE NEXT 72 HOURS (2026-09-28 11:31, NODE72-1131 / HORIZON72-1131).
//
// Three consecutive series - a series lasts 24 h - on one node with a fixed clock: every 90 s round from now to
// now + 72 h is in the node's store, the one about 72 h out among them, and /rounds?ahead=72h lists it; a lobby's plain
// /rounds sees the next ten minutes of them. A series that leaves less than the 72 h lead is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seriesWriter } from '../src/series-writer.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import {
  seriesTemplate, seriesId, seriesRound, seriesRoundsWithin, seriesLeadIsValid, seriesPublicationPayload, seriesIndexAt, seriesStartOf,
  ROUND_PERIOD_MS, SERIES_MAX_MS, SERIES_LEAD_MIN_MS, ROUNDS_PER_SERIES, SERIES_CLOCKS, seriesClockFor, SERIES_WRITE_AHEAD_MS,
} from '../../arena-protocol/src/series.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const H = 3600000;

const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,   // 82 s of its 90 s slot (the 82/90 fork: seriesRunFits)
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a series: 960 rounds 90 s apart, each closing entry at its start, and its publication is "ARN" S + its id', () => {
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW + 100 * Number(H));
  const t = seriesTemplate(base([b32(7)]), k);
  assert.equal(ROUNDS_PER_SERIES, 960);
  assert.equal(t.startTimeMs - t.committeeTimeMs, 72n * BigInt(H), 'mainnet (and regtest): committee_time = series_start - 72 h (CENSUS3D-1401)');
  assert.deepEqual(seriesLeadIsValid(t).ok, true);
  const r5 = seriesRound(t, 5);
  assert.equal(r5.startTimeMs, t.startTimeMs + 5n * ROUND_PERIOD_MS);
  assert.equal(r5.entryCloseMs, r5.startTimeMs, 'no late join');
  assert.throws(() => seriesRound(t, 960), /outside the series/);
  assert.deepEqual(seriesRoundsWithin(t, t.startTimeMs - 1000n, t.startTimeMs + 180000n), [0, 1, 2]);
  const p = seriesPublicationPayload(seriesId(t));
  assert.deepEqual([...p.subarray(0, 4)], [0x41, 0x52, 0x4e, 0x53]);
  assert.equal(p.length, 36);
  const next = seriesTemplate(base([b32(7)]), k + 1);
  assert.notDeepEqual(seriesId(next), seriesId(t), 'another series is another id');
  assert.equal(next.startTimeMs - t.startTimeMs, SERIES_MAX_MS, 'series k+1 starts 24 h after series k');
  // A SERIES DOES NOT NAME ITS OWN START (ALL-BUT-MIN-1727): one moved off the genesis grid is refused
  const moved = { ...t, startTimeMs: t.startTimeMs + ROUND_PERIOD_MS, entryCloseMs: t.startTimeMs + ROUND_PERIOD_MS, committeeTimeMs: t.committeeTimeMs + ROUND_PERIOD_MS };
  assert.match(seriesLeadIsValid(moved).why, /genesis_series_start/);
  assert.equal(t.startTimeMs, seriesStartOf(NETWORK_ID_REGTEST, k));
});

test('the node writes every round of the next 72 hours, the one 72 h out among them, and lists it', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [node.round.pubkey];
  await node.close();
  // THE SERIES RUNNING NOW AND THE NEXT THREE, on the genesis grid: 72 h of rounds from now spans them
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const series = [0, 1, 2, 3].map((j) => seriesTemplate(base(nodes), k0 + j));
  const t0 = Date.now();
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series });
  const tookMs = Date.now() - t0;
  try {
    const expected = series.reduce((n, t) => n + seriesRoundsWithin(t, BigInt(NOW), BigInt(NOW) + SERIES_LEAD_MIN_MS).length, 0);
    // THE WRITER RUNS IN ~150 ms SLICES (one turn of the loop each): under a loaded test run the last slices land after the
    // first read, so the count is read until it stops short of nothing (measured: 2839 of 2880 at the first read, 6 files at once)
    let summary, written = 0;
    for (const until = Date.now() + 30000; ;) {
      summary = await (await fetch(`http://127.0.0.1:${s.port}/series`)).json();
      written = summary.series.reduce((n, x) => n + x.written, 0);
      if (written >= expected || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(written, expected);
    const last = summary.series.map((x) => x.last).filter(Boolean).sort((a, b) => (BigInt(a.startTimeMs) < BigInt(b.startTimeMs) ? -1 : 1)).at(-1);
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
    // ROUNDS-EP-1612: /rounds?all=1 lists every announced round, each with ISO-8601 UTC start and end and who is
    // responsible - here nobody yet: this node has no chain view, so no committee is drawn, and the row says so
    const lobby = await (await fetch(`http://127.0.0.1:${s.port}/rounds?all=1`)).json();
    assert.equal(lobby.rounds.length, written, 'nothing announced is left out');
    // A BARE /rounds (kanban #742, 2026-10-29): the next 8 of each series - at grid density the full list did not answer in 90 s
    const bare = await (await fetch(`http://127.0.0.1:${s.port}/rounds`)).json();
    const heldSeries = await (await fetch(`http://127.0.0.1:${s.port}/series`)).json();
    const seriesCount = (Array.isArray(heldSeries) ? heldSeries : heldSeries.series || []).length;
    assert.ok(bare.rounds.length > 0 && bare.rounds.length < written, `a bare listing is the soonest rounds only (${bare.rounds.length} of ${written})`);
    assert.ok(bare.rounds.length <= 8 * seriesCount, `at most 8 of each of the ${seriesCount} series`);
    const row = lobby.rounds.find((r) => r.id === last.id);
    assert.equal(row.startTime, new Date(Number(lastStart)).toISOString());
    assert.ok(Date.parse(row.endTime) > Date.parse(row.startTime), 'the end is the round\'s own end, after its start');
    assert.equal(row.committee.drawn, false);
    assert.match(row.committee.why, /chain view|beacon|census/);
    const soon = await (await fetch(`http://127.0.0.1:${s.port}/rounds?ahead=${2 * 3600000}`)).json();
    assert.ok(soon.rounds.length > 0 && soon.rounds.every((r) => Date.parse(r.startTime) <= NOW + 2 * 3600000), '?ahead narrows it');
    console.log(`  FACTS: ${JSON.stringify({ written, perSeries: summary.series.map((x) => x.written), last: { index: last.index,
      inHours: Number(lastStart - BigInt(NOW)) / H, id: last.id.slice(0, 16) }, listedAt72h: all.rounds.length, plainListed: lobby.rounds.length, endOfLast: row.endTime, committee: row.committee, tookMs })}`);
  } finally { await s.close(); }
});

test('a series with less than the 72 h lead is refused whole, by name', async () => {
  const t = seriesTemplate(base([b32(7)]), seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1);
  const short = { ...t, committeeTimeMs: t.startTimeMs - 48n * BigInt(H) };        // the 48 h this morning ruled out
  assert.match(seriesLeadIsValid(short).why, /must exist 259200000 ms \(72 h\) before its first entry/);
  await assert.rejects(async () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [short] }), /series refused/);
});

// TN24-1405 AND THE 36 h CENSUS (2026-09-28): testnet4's committee_time is 24 h before the start and its lead 24 h,
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
  // SERIES 0 ON TESTNET4 starts at its genesis_series_start, 2026-10-01T00:00Z (ALL-BUT-MIN-1727): committee_time 24 h
  // before it, the census cut 36 h before it - so committee_time is 12 h after the census, the publication window
  const tn = { ...base([b32(7)]), networkId: NETWORK_ID_TESTNET4 };
  const t = seriesTemplate(tn, 0);
  assert.equal(new Date(Number(t.startTimeMs)).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(new Date(Number(t.committeeTimeMs)).toISOString(), '2026-09-30T00:00:00.000Z');
  const censusCut = t.startTimeMs - SERIES_CLOCKS.testnet4.censusLeadMs;
  assert.equal(t.committeeTimeMs - censusCut, 12n * BigInt(H), 'committee_time 12 h after the census cut');
  assert.equal(seriesLeadIsValid(t).ok, true);
  assert.equal(seriesLeadIsValid({ ...t, committeeTimeMs: t.startTimeMs - 23n * BigInt(H) }).ok, false, 'testnet4 refuses under 24 h');
  // the 3 October series keeps its 84 h lead and stays valid on testnet4
  assert.equal(seriesLeadIsValid({ ...t, committeeTimeMs: t.startTimeMs - 84n * BigInt(H) }).ok, true);
  // the writer on testnet4: 72 h of rounds ahead, not 24
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [node.round.pubkey]; await node.close();
  const series = [0, 1, 2].map((k) => seriesTemplate({ ...base(nodes), networkId: NETWORK_ID_TESTNET4 }, k));
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series });
  try {
    const sum = await (await fetch(`http://127.0.0.1:${s.port}/series`)).json();
    const last = BigInt(sum.series.map((x) => x.last).filter(Boolean).sort((a, b) => (BigInt(a.startTimeMs) < BigInt(b.startTimeMs) ? -1 : 1)).at(-1).startTimeMs);
    assert.ok(last > BigInt(NOW) + 72n * BigInt(H) - ROUND_PERIOD_MS && last <= BigInt(NOW) + 72n * BigInt(H), 'testnet4 rounds written 72 h ahead');
    console.log(`  FACTS: testnet4 written ${sum.series.reduce((n, x) => n + x.written, 0)}, last ${(Number(last) - NOW) / H} h out`);
  } finally { await s.close(); }
});

// ALWAYS A PAID ROW (2026-10-01 15:25, HARD: "The nodes always serve both at once ... a free row and a paid
// testnet4 row together"): the node assigns signer nodes to the rounds starting within 2 h AND to the soonest round,
// however far ahead - measured on testnet4 the same day, series 8172fffd's first round 8 h out was assigned by no node and
// the page showed no paid row. The writer names that round: nothing within 2 h, and `soonest` is the first round.
test('a series whose first round is 8 h out has none within the 2 h lead, and the writer names that first round as the soonest', () => {
  const round = new Round(openStore(':memory:'), () => NOW, { plugins: HOSTED });
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1;
  const t = seriesTemplate(base([round.pubkey]), k);
  const start = seriesStartOf(NETWORK_ID_REGTEST, k);
  const at = Number(start) - 8 * H;
  const w = seriesWriter(round, t);
  w.write(at);
  const within = w.startingWithin(at, 2 * H);
  const first = seriesRound(t, 0);
  console.log(`  FACTS (soonest): ${JSON.stringify({ firstInHours: (Number(start) - at) / H, within: within.length, soonest: (w.soonest(at) || '').slice(0, 16) })}`);
  assert.equal(within.length, 0, 'a round starts within 2 h: not the case the test names');
  assert.equal(w.soonest(at), Buffer.from(roundIdOf(first)).toString('hex'), 'the soonest is not the series\' first round');
  assert.equal(w.soonest(Number(start) + 1), w.startingWithin(Number(start) + 1, 2 * H)[0], 'once rounds run, the soonest is the next one');
});

// THE 82/90 FORK (2026-10-01): a series on the core that takes its rounds' run length fits 82 s into its 90 s slot -
// 4920 ticks (81 979 ms) is taken - 4921 (81 996 ms) is the longest that fits - and 4922 (82 013 ms) and 10800 (180 s) are refused by name.
test('a series runs at most 82 s of its 90 s slot: 4920 and 4921 ticks are taken, 4922 and 10800 are refused by name', async () => {
  const { seriesRunFits } = await import('../../arena-protocol/src/series.js');
  const t = (blockTicks) => seriesTemplate({ ...base([b32(1)]), blockTicks }, seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1);
  assert.equal(seriesRunFits(t(4920)).ok, true);
  assert.equal(seriesRunFits(t(4920)).runMs, 81979n);
  assert.equal(seriesRunFits(t(4921)).ok, true);
  for (const ticks of [4922, 10800]) assert.match(seriesRunFits(t(ticks)).why, new RegExp(`a run of ${ticks} ticks is \\d+ ms, and a round of a 90000 ms series runs at most 82000 ms`));
  await assert.rejects(async () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [t(10800)] }), /series refused: a run of 10800 ticks/);
});

// A SERIES ADDED WHILE THE NODE RUNS IS TAKEN WITHOUT A RESTART (2026-10-02: "find out the reason for the restarts
// and find a way to recover from them" - the 82/90 waiter restarted the seven seats one at a time after each day's series,
// and a seat restarted between a join and its round's start lost the player's run, FORFEIT). A node started holding one
// series is handed a second by seriesReload; on its next writer pass it writes and lists the second too, and a reload
// answering null (the file unchanged) or failing changes nothing.
test('a series added to the file while the node runs is written on the next pass, no restart', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [node.round.pubkey];
  await node.close();
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW);
  const first = seriesTemplate(base(nodes), k0 + 1);
  const second = seriesTemplate(base(nodes), k0 + 2);
  const answers = [null, () => { throw new Error('half-written file'); }, [first, second], null];
  let asked = 0;
  const seriesReload = () => { const a = answers[Math.min(asked++, answers.length - 1)]; return typeof a === 'function' ? a() : a; };
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [first], seriesEveryMs: 100, seriesReload });
  try {
    const ids = async () => (await (await fetch(`http://127.0.0.1:${s.port}/series`)).json()).series.map((x) => x.series);
    const before = await ids();
    for (let t = Date.now(); Date.now() - t < 5000 && asked < 4; await new Promise((r) => setTimeout(r, 100)));
    const after = await ids();
    console.log('  FACTS:', JSON.stringify({ before: before.map((x) => x.slice(0, 8)), after: after.map((x) => x.slice(0, 8)), asked }));
    assert.equal(before.length, 1);
    assert.equal(after.length, 2, 'the second series was not taken');
    assert.ok(after.includes(toHexId(seriesId(second))), 'the series taken is not the one added');
  } finally { await s.close(); }
});
const toHexId = (b) => Buffer.from(b).toString('hex');

// A SERIES TAKEN OUT OF THE FILE WHILE THE NODE RUNS IS DROPPED (2026-10-06: series d37c1ef1 and
// 0813e1a3 named the old donation set, every join into them was refused after the stake was locked, and the reload only
// added - measured: the file read again, both series still held, all 1920 rounds still listed). Two series with one start,
// as d37c1ef1 beside a69552a0; the file then names one: the other is no longer held or written, its stored rounds are
// listed nowhere and a re-post of one is refused by name, while the series still in the file stays held and listed. A read
// naming no series at all (a file caught empty mid-write) drops nothing.
test('a series taken out of the file while the node runs is dropped: not held, its rounds not listed or re-posted; the other stays', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [node.round.pubkey];
  await node.close();
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1;
  const keep = seriesTemplate(base(nodes), k);
  const drop = { ...seriesTemplate(base(nodes), k), donationSetId: b32(9) };
  let answer = null, asked = 0;
  const seriesReload = () => { asked++; const a = answer; answer = null; return a; };
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [keep, drop], seriesEveryMs: 100, seriesReload });
  try {
    const held = async () => (await (await fetch(`http://127.0.0.1:${s.port}/series`)).json()).series.map((x) => ({ id: x.series, written: x.written }));
    const listed = async () => (await (await fetch(`http://127.0.0.1:${s.port}/rounds?ahead=72h`)).json()).rounds.map((r) => r.id);
    const idOf = (t, i) => toHexId(roundIdOf(seriesRound(t, i)));
    for (let t = Date.now(); Date.now() - t < 20000 && !(await held()).every((x) => x.written >= ROUNDS_PER_SERIES); await new Promise((r) => setTimeout(r, 200)));
    const before = { held: await held(), listed: await listed(), stored: s.round.db.prepare('SELECT count(*) n FROM rounds').get().n };
    answer = [keep];
    for (let t = Date.now(); Date.now() - t < 5000 && answer !== null; await new Promise((r) => setTimeout(r, 50)));
    await new Promise((r) => setTimeout(r, 300));
    const after = { held: await held(), listed: await listed(), stored: s.round.db.prepare('SELECT count(*) n FROM rounds').get().n };
    const repost = await fetch(`http://127.0.0.1:${s.port}/round`, { method: 'POST', body: encodeRoundContract(seriesRound(drop, 5)) });
    const repostWhy = await repost.text();
    answer = [];
    for (let t = Date.now(); Date.now() - t < 5000 && answer !== null; await new Promise((r) => setTimeout(r, 50)));
    await new Promise((r) => setTimeout(r, 300));
    const afterEmpty = { held: await held(), listed: await listed() };
    console.log('  FACTS:', JSON.stringify({
      before: { held: before.held.map((x) => `${x.id.slice(0, 8)}:${x.written}`), listed: before.listed.length, stored: before.stored },
      after: { held: after.held.map((x) => `${x.id.slice(0, 8)}:${x.written}`), listed: after.listed.length, stored: after.stored },
      repost: [repost.status, repostWhy.slice(0, 120)], afterEmpty: { held: afterEmpty.held.length, listed: afterEmpty.listed.length }, asked }));
    assert.deepEqual(before.held.map((x) => x.id).sort(), [toHexId(seriesId(keep)), toHexId(seriesId(drop))].sort());
    assert.equal(before.listed.length, 2 * ROUNDS_PER_SERIES);
    assert.ok(before.listed.includes(idOf(drop, 0)) && before.listed.includes(idOf(keep, 0)));
    assert.deepEqual(after.held.map((x) => x.id), [toHexId(seriesId(keep))], 'the series taken out of the file is still held');
    assert.equal(after.listed.length, ROUNDS_PER_SERIES, 'the listing did not fall by exactly the dropped series');
    assert.ok(!after.listed.includes(idOf(drop, 0)) && !after.listed.includes(idOf(drop, ROUNDS_PER_SERIES - 1)), 'a dropped round is still listed');
    assert.ok(after.listed.includes(idOf(keep, 0)) && after.listed.includes(idOf(keep, ROUNDS_PER_SERIES - 1)), 'the kept series lost a round');
    assert.equal(after.stored, before.stored, 'the stored rounds are kept (hidden, not deleted: a stake in one can still settle)');
    assert.equal(repost.status, 409);
    assert.match(repostWhy, /taken out of this node's series file/);
    assert.equal(afterEmpty.held.length, 1, 'a read naming no series dropped the rest');
    assert.equal(afterEmpty.listed.length, ROUNDS_PER_SERIES);
  } finally { await s.close(); }
});

// A GAME'S round_period IS READ (hole 3 of comment 747): every series of this network runs on the 90 s grid,
// so a game whose manifest names another period gets no series here - refused by the series writer and by the door's
// game check (pluginForRound) for a round of a series - while one naming 90 s, or 0 (no period), runs.
test('a series of a game whose manifest names a 60 s period is refused by the writer and the door; 90 s and 0 run', async () => {
  const { pluginForRound } = await import('../src/plugins.js');
  const { NEXTBLOCK } = await import('../../nextblock/plugin/nextblock.js');
  const { TALLY_CORE } = await import('./plugins/tally/index.js');
  const { testGame } = await import('./plugins/sign.js');
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  const cores = new Map([[TALLY_CORE.hash, TALLY_CORE]]);
  const games = {
    p90: testGame({ name: 'tally90', cores, runTicksMax: 600, roundPeriodMs: 90000n }),
    p60: testGame({ name: 'tally60', cores, runTicksMax: 600, roundPeriodMs: 60000n }),
    p0: testGame({ name: 'tally0', cores, runTicksMax: 600 }),
  };
  const round = new Round(openStore(':memory:'), () => NOW, { plugins: [NEXTBLOCK, ...Object.values(games)] });
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW) + 1;
  const templateOf = (g) => seriesTemplate({ ...base([round.pubkey]), gameId: g.gameId, simCoreHash: Uint8Array.from(Buffer.from(TALLY_CORE.hash, 'hex')),
    configHash: Uint8Array.from(Buffer.from([...TALLY_CORE.configs.keys()][0], 'hex')), blockTicks: 600, startDeadlineTicks: 300 }, k);
  const facts = {};
  for (const [name, g] of Object.entries(games)) {
    const t = templateOf(g);
    let writer = 'ok';
    try { seriesWriter(round, t); } catch (e) { writer = e.message; }
    const door = pluginForRound(seriesRound(t, 0), round.plugins);
    // the same game outside a series is not asked for a period
    const lone = pluginForRound({ ...t, startDeadlineTicks: 300 }, round.plugins);
    facts[name] = { writer, door: door.ok ? 'ok' : door.why, lone: lone.ok ? 'ok' : lone.why, game: toHex(g.gameId).slice(0, 16) };
  }
  console.log('  FACTS (round_period):', JSON.stringify(facts));
  const why = 'game "tally60" runs every 60000 ms, and this network\'s series run every 90000 ms';
  assert.equal(facts.p60.writer, `series refused: ${why}`);
  assert.equal(facts.p60.door, why);
  assert.equal(facts.p60.lone, 'ok');
  for (const k2 of ['p90', 'p0']) assert.deepEqual([facts[k2].writer, facts[k2].door, facts[k2].lone], ['ok', 'ok', 'ok'], k2);
});

// A RESTART DOES NOT OPEN THE 72 h AGAIN (measured on seat 2's start 2026-10-18 07:51Z: ~4,500 rounds re-opened,
// each checked in its core's sandbox, the loop held 6.4 s): a writer over a store that holds its rounds remembers them as written,
// opens none, and knows the same rounds as the writer before it
test('a series writer after a restart opens none of the rounds its store holds, and knows them all', () => {
  const round = new Round(openStore(':memory:'), () => NOW, { plugins: HOSTED });
  const k = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const t = seriesTemplate(base([b32(7)]), k);
  const first = seriesWriter(round, t);
  const added = first.write(NOW);
  assert.ok(added > 100, `the first writer opens the series' rounds within 72 h (${added})`);
  let opened = 0;
  const open = round.open.bind(round);
  round.open = (c) => { opened += 1; return open(c); };
  const again = seriesWriter(round, t);
  assert.equal(again.write(NOW), 0, 'nothing new to write');
  assert.equal(opened, 0, 'and no round opened again');
  assert.deepEqual([...again.ids()].sort(), [...first.ids()].sort(), 'the same rounds, known');
  assert.deepEqual(again.summary(NOW), first.summary(NOW));
  // a round the store does not hold (deleted here) is opened again, and only that one
  const gone = [...first.ids()][0];
  round.db.prepare('DELETE FROM rounds WHERE round_id = ?').run(Buffer.from(gone, 'hex'));
  assert.equal(seriesWriter(round, t).write(NOW), 1);
  assert.equal(opened, 1);
});
