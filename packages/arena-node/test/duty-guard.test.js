// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DAILY DUTY, HARDENED (kanban #689, 2026-10-26: "Make sure that we always post rounds properly for the next day. Harden it. Always the
// newest app version. We had too many failures."): each failure of 10-24..10-26 as a case of src/duty-guard.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import {
  catalogOf, hostsOf, pickNewestVersion, pinVerdict, pickCore, dutyFieldsOf, headerHashes, chainAgreement, postingVerdict, dayVerdict,
  emergencyDue, emergencyPlan, confirmedPosting, DUTY_CONFIRMED_BY_MS, dayDueCapped, dayDueFromMs, dayTimeline, drawCount, statusLine, dayShape, DUTY_DAY_COMMITTEE_LEAD_MS, DUTY_DRAWABLE_BY_MS,
} from '../src/duty-guard.js';
import * as guard from '../src/duty-guard.js';

const H = 3600000;
const id = (n) => toHex(new Uint8Array(32).fill(n));
const DEV = 'ab'.repeat(32);
const manifestOf = (name, version, extra = {}) => ({ gameName: name, version, gameDevPubkey: fromHex(DEV), requiredProtocolVersion: 2, cores: [], ...extra });
// a catalog as catalogOf builds it, from listings whose "manifest" is the id it decodes to
const catalogFrom = (games) => catalogOf([{ games: games.map((g) => ({ id: g.id, manifest: g.id })) }],
  { decode: (bytes) => games.find((g) => g.id === toHex(bytes)).m, idOf: (m) => fromHex(games.find((g) => g.m === m).id) });
const entry = (hosts, roles = ['game', 'verify', 'settlement']) => ({ roles, hostedGames: hosts.map(fromHex) });
const contract = { networkId: NETWORK_ID_TESTNET4 };

test('the newest version whose census game nodes can draw a committee: v24 hosted by 3 is posted, not v13 (10-26 grid)', () => {
  const cat = catalogFrom([{ id: id(13), m: manifestOf('btc-updown-15m', 13) }, { id: id(24), m: manifestOf('btc-updown-15m', 24) },
    { id: id(9), m: manifestOf('nextblock', 9) }]);
  const entries = [entry([id(13), id(24)]), entry([id(13), id(24)]), entry([id(24)])];
  const got = pickNewestVersion({ name: 'btc-updown-15m', dev: DEV, catalog: cat, protocol: 3, hosts: (g) => hostsOf(entries, contract, fromHex(g)) });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.pick.version, 24);
  assert.equal(got.have, 3);
});

test('a newer version too few census nodes host is passed over and said why (10-26: "0 game nodes" for v24); one needing a newer protocol too', () => {
  const cat = catalogFrom([{ id: id(13), m: manifestOf('btc-updown-15m', 13) }, { id: id(24), m: manifestOf('btc-updown-15m', 24) },
    { id: id(25), m: manifestOf('btc-updown-15m', 25, { requiredProtocolVersion: 11 }) }]);
  const entries = [entry([id(13)]), entry([id(13), id(24)])];
  const got = pickNewestVersion({ name: 'btc-updown-15m', dev: DEV, catalog: cat, protocol: 3, hosts: (g) => hostsOf(entries, contract, fromHex(g)) });
  assert.equal(got.pick.version, 13);
  assert.match(got.tried[0].why, /needs protocol 11/);
  assert.match(got.tried[1].why, /carries 1 game node .* needing 2/);
  const none = pickNewestVersion({ name: 'btc-updown-15m', dev: DEV, catalog: cat, protocol: 3, hosts: () => ({ ok: false, have: 0, need: 2, why: 'none' }) });
  assert.equal(none.ok, false);
  assert.match(none.why, /no version of btc-updown-15m has a drawable committee/);
});

test('another developer key under the same name is no version of the app; a manifest that is not its id is left out', () => {
  const cat = catalogFrom([{ id: id(5), m: manifestOf('rock-paper-scissors', 5) }, { id: id(7), m: { ...manifestOf('rock-paper-scissors', 7), gameDevPubkey: new Uint8Array(32) } }]);
  const got = pickNewestVersion({ name: 'rock-paper-scissors', dev: DEV, catalog: cat, protocol: 3, hosts: () => ({ ok: true, have: 9, need: 2 }) });
  assert.equal(got.pick.version, 5);
  const lying = catalogOf([{ games: [{ id: id(1), manifest: id(2) }] }], { decode: () => manifestOf('x', 1), idOf: () => fromHex(id(2)) });
  assert.equal(lying.size, 0);
});

test('a settlement pool too small is no committee either', () => {
  const entries = [entry([id(1)], ['game', 'verify']), entry([id(1)], ['game', 'verify']), entry([], ['settlement'])];
  const h = hostsOf(entries, contract, fromHex(id(1)));
  assert.equal(h.ok, false);
  assert.match(h.why, /settlement/);
});

test('a pin older than the newest drawable version is refused, loudly; the pin stands only when nothing newer is known', () => {
  const cat = catalogFrom([{ id: id(13), m: manifestOf('btc-updown-15m', 13) }, { id: id(24), m: manifestOf('btc-updown-15m', 24) }]);
  const picked = { ok: true, pick: cat.get(id(24)) };
  const old = pinVerdict({ pinId: id(13), picked, catalog: cat });
  assert.deepEqual([old.use, old.loud], ['pick', true]);
  assert.match(old.why, /version 13\) is not the newest drawable version 24 \(1818181818181818\): refused/);
  assert.deepEqual(pinVerdict({ pinId: id(24), picked, catalog: cat }), { use: 'pick', loud: false });
  assert.deepEqual(pinVerdict({ pinId: null, picked, catalog: cat }), { use: 'pick', loud: false });
  const unknown = pinVerdict({ pinId: id(13), picked: { ok: false, why: 'no seat answered GET /games' }, catalog: null });
  assert.deepEqual([unknown.use, unknown.loud], ['pin', true]);
  assert.equal(pinVerdict({ pinId: null, picked: { ok: false, why: 'x' } }).use, 'none');
});

test('round fields from the manifest as the seats hold it: Up/Down a market, RPS its core and first config, Tick Tock the core named', () => {
  const core = (n, configs) => ({ hash: new Uint8Array(32).fill(n), configs: configs.map((c) => new Uint8Array(32).fill(c)) });
  const ud = dutyFieldsOf('updown', { id: id(24), name: 'btc-updown-15m', version: 24, manifest: manifestOf('btc-updown-15m', 24, { roundPeriodMs: 900000n, marketTerms: { nodeFeeBps: 40 } }) }, { fromHex });
  assert.equal(ud.ok, true);
  assert.equal(ud.periodMs, 900000);
  assert.deepEqual(ud.fields.simCoreHash, new Uint8Array(32));
  assert.equal(toHex(ud.fields.gameId), id(24));
  const rps = dutyFieldsOf('rps', { id: id(5), name: 'rock-paper-scissors', version: 5, manifest: manifestOf('rock-paper-scissors', 5, { minScore: 2, cores: [core(0xf8, [0x0d, 0x0e])] }) },
    { fromHex, base: { blockTicks: 600, startDeadlineTicks: 300 } });
  assert.deepEqual({ ...rps.fields, gameId: toHex(rps.fields.gameId), simCoreHash: toHex(rps.fields.simCoreHash), configHash: toHex(rps.fields.configHash) },
    { blockTicks: 600, startDeadlineTicks: 300, minScore: 2, gameId: id(5), simCoreHash: id(0xf8), configHash: id(0x0d) });
  // Tick Tock v6 names two cores (0847c99f and a5c5766a): the one DUTY_NEXTBLOCK_CORE names, never a guess
  const v6 = { id: id(6), name: 'nextblock', version: 6, manifest: manifestOf('nextblock', 6, { cores: [core(0x08, [1]), core(0xa5, [1])] }) };
  assert.equal(toHex(dutyFieldsOf('nextblock', v6, { core: '0808', fromHex }).fields.simCoreHash), id(0x08));
  assert.equal(toHex(dutyFieldsOf('nextblock', v6, { preferCore: id(0xa5), fromHex }).fields.simCoreHash), id(0xa5));
  assert.match(dutyFieldsOf('nextblock', v6, { fromHex }).why, /names 2 cores .* none chosen/);
  assert.equal(pickCore([core(1, [])]).ok, true);
});

test('the seats\' chains: a census block on our own branch is refused before publishing (10-26, census 157510 of a branch the chain left)', () => {
  const hdr = (n) => { const h = new Uint8Array(80); h[0] = n; return h; };
  const bytes = new Uint8Array([...hdr(1), ...hdr(2), ...hdr(3)]);
  const set = headerHashes(bytes, blockHashOf);
  assert.equal(set.size, 3);
  const ours = toHex(Uint8Array.from(blockHashOf(hdr(2))).reverse());          // display order, as getblockhash prints it
  assert.equal(set.has(ours), true);
  const other = new Set(['00'.repeat(32)]);
  assert.equal(chainAgreement({ hash: ours, answers: [set, set, set, other, null] }).ok, true);
  const split = chainAgreement({ hash: ours, answers: [set, other, other, other, null, null] });
  assert.equal(split.ok, false);
  assert.match(split.why, /on the chain of 1 of 4 seats: a branch the seats do not follow/);
  assert.match(chainAgreement({ hash: ours, answers: [set, null, null] }).why, /only 1 seat\(s\) answered/);
});

test('a posting confirmed after its beacon is dead (10-25 #633); one whose census branch the chain left is dead (10-26)', () => {
  const at = { tip: 1000, nowMs: 0 };
  assert.deepEqual(postingVerdict({ ...at, pubHeight: 990, beaconAt: 985 }).state, 'dead');
  assert.match(postingVerdict({ ...at, pubHeight: null, beaconAt: 985 }).why, /came while the publication was unconfirmed/);
  assert.match(postingVerdict({ ...at, censusOnChain: false, pubHeight: 900, beaconAt: 950 }).why, /left the branch/);
  assert.equal(postingVerdict({ ...at, seatsAgree: { ok: false, of: 5, agree: 1, why: 'branch' }, pubHeight: 900 }).state, 'dead');
  assert.deepEqual(postingVerdict({ ...at, pubHeight: null }).stage, 'unconfirmed');
  // conflicted: a mined transaction spends its coins - dead at once, not waited for until the beacon (kanban #689, 2026-10-26)
  assert.deepEqual([postingVerdict({ ...at, pubHeight: null, conflicted: true }).state, postingVerdict({ ...at, pubHeight: null, conflicted: true }).stage], ['dead', 'publication']);
  assert.match(postingVerdict({ ...at, pubHeight: null, conflicted: true }).why, /never mined/);
  assert.deepEqual(postingVerdict({ ...at, pubHeight: 900 }).stage, 'published');
  assert.match(postingVerdict({ ...at, pubHeight: 900, beaconAt: 998 }).why, /3 of 6 deep/);
  assert.equal(postingVerdict({ ...at, pubHeight: 900, beaconAt: 990 }).stage, 'seats');
});

test('deep and posted: drawn on most seats it is drawable; not drawn past the grace it is dead, never re-posted', () => {
  const at = { tip: 1000, pubHeight: 900, beaconAt: 990 };
  assert.equal(postingVerdict({ ...at, nowMs: 0, draw: { drawn: 5, undrawn: 2, of: 7 } }).state, 'drawable');
  assert.equal(postingVerdict({ ...at, nowMs: 10 * 60000, postedAtMs: 0, draw: { drawn: 0, undrawn: 7, of: 7, why: 'root' } }).state, 'pending');
  const dead = postingVerdict({ ...at, nowMs: 60 * 60000, postedAtMs: 0, draw: { drawn: 0, undrawn: 7, of: 7, why: 'that round names census root 743b74ae' } });
  assert.equal(dead.state, 'dead');
  assert.match(dead.why, /not drawn on 7 of 7 seats: that round names census root/);
});

test('the seats\' rounds of one game in a day: drawn on a majority or not', () => {
  const day = { fromMs: Date.parse('2026-10-27T00:00:00Z'), toMs: Date.parse('2026-10-28T00:00:00Z') };
  const row = (g, at, drawn) => ({ game: { id: g }, startTime: at, committee: drawn ? { drawn: true } : { drawn: false, why: 'census carries 0 game nodes' } });
  const listings = [{ rounds: [row(id(24), '2026-10-27T00:00:00Z', true)] }, { rounds: [row(id(24), '2026-10-27T00:15:00Z', false)] },
    { rounds: [row(id(13), '2026-10-27T00:00:00Z', true)] }, null, { rounds: [row(id(24), '2026-10-26T23:45:00Z', true)] }];
  assert.deepEqual(drawCount(listings, { gameId: id(24), ...day }), { drawn: 1, undrawn: 1, of: 2, why: 'census carries 0 game nodes' });
  // a seat still reading its view after a reorg says nothing either way
  const reading = { rounds: [{ game: { id: id(24) }, startTime: '2026-10-27T01:00:00Z', committee: { drawn: false, why: 'this node has no chain view for that round, so it cannot say who is bonded' } }] };
  assert.deepEqual(drawCount([...listings, reading], { gameId: id(24), ...day }).of, 2);
});

test('a round drawn short is not drawn: 3 nodes a role cannot seat 5 (measured 2026-10-27, Up/Down v24)', () => {
  const day = { fromMs: Date.parse('2026-10-27T00:00:00Z'), toMs: Date.parse('2026-10-28T00:00:00Z') };
  const row = (n) => ({ game: { id: id(24) }, startTime: '2026-10-27T10:00:00Z', committee: { drawn: { game: [], settlement: [] }, drawnCount: { game: n, settlement: n } } });
  const short = drawCount([{ rounds: [row(3)] }, { rounds: [row(3)] }], { gameId: id(24), ...day });
  assert.deepEqual([short.drawn, short.undrawn, short.of], [0, 2, 2]);
  assert.match(short.why, /drawn short: 3 nodes a role, 5 needed to seat/);
  assert.deepEqual(drawCount([{ rounds: [row(9)] }], { gameId: id(24), ...day }).drawn, 1, 'nine drawn: drawable');
  assert.equal(postingVerdict({ tip: 1000, pubHeight: 900, beaconAt: 990, nowMs: 60 * 60000, postedAtMs: 0, draw: short }).state, 'dead', 'and the day gets its emergency grid');
});

test('a round drawn in full but never seated is not drawn: its drawn nodes are stopped (kanban #727, Up/Down v23 2026-10-27)', () => {
  const day = { fromMs: Date.parse('2026-10-27T00:00:00Z'), toMs: Date.parse('2026-10-28T00:00:00Z') };
  const row = (seated) => ({ id: '399ac2293d991c68', game: { id: id(24) }, startTime: '2026-10-27T12:45:00Z',
    committee: { drawn: { game: [], settlement: [] }, drawnCount: { game: 9, settlement: 9 }, seated: { game: seated, settlement: seated } } });
  const at = (iso) => Date.parse(iso);
  // listed 30 s before its start, nothing seated: its seating has closed - not drawable on that seat
  const dead = drawCount([{ nowMs: at('2026-10-27T12:44:30Z'), rounds: [row(false)] }, { nowMs: at('2026-10-27T12:44:40Z'), rounds: [row(false)] }], { gameId: id(24), ...day });
  assert.deepEqual([dead.drawn, dead.undrawn, dead.of], [0, 2, 2]);
  assert.match(dead.why, /drawn but not seated: round 399ac229/);
  // listed 8 min before its start, its seating still to come: drawable as before
  assert.equal(drawCount([{ nowMs: at('2026-10-27T12:37:00Z'), rounds: [row(false)] }], { gameId: id(24), ...day }).drawn, 1);
  // seated: drawable
  assert.equal(drawCount([{ nowMs: at('2026-10-27T12:44:30Z'), rounds: [row(true)] }], { gameId: id(24), ...day }).drawn, 1);
  // and with no time at all the listing says nothing about it
  assert.equal(drawCount([{ rounds: [row(false)] }], { gameId: id(24), ...day }).drawn, 1);
});

test('the day: drawable when one posting is, dead when all are; an emergency grid when dead, or not drawable 4 h before it starts', () => {
  const day = { startMs: 100 * H, endMs: 124 * H };
  assert.equal(dayVerdict([{ state: 'dead' }, { state: 'drawable' }]).state, 'drawable');
  assert.equal(dayVerdict([{ state: 'dead', why: 'a' }, { state: 'dead', why: 'b' }]).state, 'dead');
  assert.equal(dayVerdict([]).state, 'none');
  assert.equal(emergencyDue({ nowMs: 80 * H, day, verdict: { state: 'dead', why: 'x' } }).due, true);
  assert.equal(emergencyDue({ nowMs: 80 * H, day, verdict: { state: 'pending' } }).due, false);
  assert.equal(emergencyDue({ nowMs: 100 * H - DUTY_DRAWABLE_BY_MS, day, verdict: { state: 'pending', why: 'beacon 3 of 6 deep' } }).due, true);
  assert.equal(emergencyDue({ nowMs: 110 * H, day, verdict: { state: 'pending' } }).due, true);           // and while the day runs
  assert.equal(emergencyDue({ nowMs: 110 * H, day, verdict: { state: 'drawable' } }).due, false);
  assert.equal(emergencyDue({ nowMs: 124 * H, day, verdict: { state: 'dead' } }).due, false);
  assert.equal(emergencyDue({ nowMs: 110 * H, day, verdict: { state: 'dead' }, inFlight: true }).due, false);
  assert.equal(emergencyDue({ nowMs: 110 * H, day, verdict: { state: 'dead' }, emergencies: 3 }).due, false);
  assert.equal(emergencyDue({ nowMs: 80 * H, day, verdict: { state: 'none' }, postedAny: false, dutyOverMs: 79 * H }).due, true);
  // a day posted at the old 6 h lead (committee 18:00Z) is given until 22:00Z to be drawn; at the 12 h lead the 20:00Z mark stands
  assert.equal(emergencyDue({ nowMs: 97 * H, day, verdict: { state: 'pending' }, pendingCommitteeMs: 94 * H }).due, false);
  assert.equal(emergencyDue({ nowMs: 98 * H, day, verdict: { state: 'pending' }, pendingCommitteeMs: 94 * H }).due, true);
  assert.equal(emergencyDue({ nowMs: 96 * H, day, verdict: { state: 'pending' }, pendingCommitteeMs: 88 * H }).due, true);
  // NO CONFIRMED ROUNDS BY 16:00 UTC THE DAY BEFORE (kanban #775): due at 8 h before the day, even with another node's marker pending to 22:00Z
  assert.equal(emergencyDue({ nowMs: 92 * H - 1, day, verdict: { state: 'pending' }, pendingCommitteeMs: 94 * H, confirmedAny: false }).due, false);
  const c = emergencyDue({ nowMs: 92 * H, day, verdict: { state: 'pending' }, pendingCommitteeMs: 94 * H, confirmedAny: false });
  assert.equal(c.due, true);
  assert.match(c.why, /no confirmed rounds of it by/);
  assert.equal(emergencyDue({ nowMs: 92 * H, day, verdict: { state: 'pending' }, pendingCommitteeMs: 94 * H, confirmedAny: true }).due, false);
  assert.equal(emergencyDue({ nowMs: 92 * H, day, verdict: { state: 'drawable' }, confirmedAny: false }).due, false);
  assert.equal(DUTY_CONFIRMED_BY_MS, 8 * H);
  assert.equal(confirmedPosting({ state: 'pending', stage: 'beacon' }), true);
  assert.equal(confirmedPosting({ state: 'pending', stage: 'unconfirmed' }), false);
  assert.equal(confirmedPosting({ state: 'dead', stage: 'census' }), false);
  assert.equal(confirmedPosting({ state: 'pending', stage: 'foreign' }), false);
});

test('an emergency grid: committee 2 h past the median, first start 140 min after it, on the period grid, to the day\'s end', () => {
  const day = { startMs: Date.parse('2026-10-26T00:00:00Z'), endMs: Date.parse('2026-10-27T00:00:00Z') };
  const nowMs = Date.parse('2026-10-26T10:00:00Z'), mtpMs = Date.parse('2026-10-26T09:10:00Z');
  const p = emergencyPlan({ nowMs, mtpMs, day, shape: dayShape('updown', 900000) });
  assert.equal(p.ok, true);
  assert.equal(new Date(p.committeeMs).toISOString(), '2026-10-26T11:10:00.500Z');
  assert.equal(new Date(p.firstStartMs).toISOString(), '2026-10-26T13:45:00.000Z');
  assert.equal(p.firstCloseMs, p.firstStartMs);
  assert.equal(p.slots, 41);
  // the next day, asked in the afternoon before: the whole of it, nothing lost
  const next = { startMs: day.endMs, endMs: day.endMs + 24 * H };
  const q = emergencyPlan({ nowMs: Date.parse('2026-10-26T15:00:00Z'), mtpMs: Date.parse('2026-10-26T14:00:00Z'), day: next, shape: dayShape('rps') });
  assert.deepEqual([q.firstStartMs, q.slots, q.lostMs, q.firstCloseMs - q.firstStartMs], [next.startMs, 10800, 0, 80000]);
  assert.equal(emergencyPlan({ nowMs: day.endMs - 60000, mtpMs: day.endMs, day, shape: dayShape('nextblock') }).ok, false);
});

test('the timeline: committee 12 h before the day, posted by 03:00Z at the latest whatever the rank, drawable by 20:00Z', () => {
  const slot = 20752, t = dayTimeline(slot);
  assert.equal(new Date(t.postFromMs).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(new Date(t.postByMs).toISOString(), '2026-10-26T03:00:00.000Z');
  assert.equal(new Date(t.committeeMs).toISOString(), '2026-10-26T12:00:00.000Z');
  assert.equal(new Date(t.drawableByMs).toISOString(), '2026-10-26T20:00:00.000Z');
  assert.equal(t.startMs - t.committeeMs, DUTY_DAY_COMMITTEE_LEAD_MS);
  const at = (h) => Date.parse('2026-10-26T00:00:00Z') + h * H;
  // rank 9 (10-24: census nodes running no duty runner first) posts inside 02:00-03:00Z, not 09:00Z: at 02:21Z, its own 3-min step (#788)
  assert.equal(dayDueCapped({ nowMs: at(2), slot, rank: 9, posted: false }), false);
  assert.equal(dayDueCapped({ nowMs: at(2) + 21 * 60000, slot, rank: 9, posted: false }), true);
  // EVERY RANK PAST THE CAP ITS OWN STEP (kanban #788: 10-30's Up/Down day was posted four times at 02:00Z): 2 at 02:00, 3 at 02:03, ... and
  // the last steps at 02:57, so the day is posted by 03:00Z whatever the rank
  assert.deepEqual([2, 3, 4, 21, 30, 200].map((r) => new Date(dayDueFromMs(slot, r)).toISOString().slice(11, 16)), ['02:00', '02:03', '02:06', '02:57', '02:57', '02:57']);
  assert.deepEqual([0, 1].map((r) => new Date(dayDueFromMs(slot, r)).toISOString().slice(11, 16)), ['00:00', '01:00']);
  assert.ok(dayDueFromMs(slot, 1e6) < t.postByMs);
  assert.equal(dayDueCapped({ nowMs: at(0), slot, rank: 0, posted: false }), true);
  assert.equal(dayDueCapped({ nowMs: at(5), slot, rank: 1, posted: true }), false);
  assert.equal(dayDueCapped({ nowMs: at(5), slot, rank: -1, posted: false }), false);
});

test('the status line: one JSON object per game and day', () => {
  const line = statusLine({ item: 'updown-day', day: { startMs: Date.parse('2026-10-27T00:00:00Z') }, verdict: { state: 'pending', why: 'beacon 2 of 6 deep' },
    postings: [{ txid: 'aa'.repeat(32), version: 24, gameId: id(24), firstStartMs: Date.parse('2026-10-27T00:00:00Z'), verdict: { state: 'pending', stage: 'beacon', why: 'beacon 2 of 6 deep' } }] });
  assert.equal(line.dutyStatus, 'updown-day');
  assert.equal(line.day, '2026-10-27');
  assert.deepEqual(line.postings[0], { txid: 'aa'.repeat(8), version: 24, game: id(24).slice(0, 16), emergency: false, firstStart: '2026-10-27T00:00:00.000Z', state: 'pending', stage: 'beacon', why: 'beacon 2 of 6 deep' });
  JSON.stringify(line);
});

test('another node\'s posting of the day, 6 deep, counts as confirmed until its rounds can be listed (kanban #775, option 1)', () => {
  // the 10-30 measurement (2026-10-29): posted at 157984 (03:01Z); at 16:00Z no seat listed rounds - they are written from 21:00Z
  const dayStartMs = Date.UTC(2026, 9, 30), at = (h) => dayStartMs - (24 - h) * 3600000;
  const tag = 'aabbccdd', slot = 20755;
  const posting = { slot, tag, kind: 'D', height: 157984 };
  const ask = (markers, nowMs, tipHeight = 158060) => guard.foreignConfirmed({ markers, slot, tag, tipHeight, nowMs, dayStartMs });
  assert.equal(ask([posting], at(16)), true, '16:00Z: a primary 6 deep counts');
  assert.equal(ask([posting], at(20) + 59 * 60000), true, 'still at 20:59Z');
  assert.equal(ask([posting], at(21)), false, 'from 21:00Z only listed rounds count');
  assert.equal(ask([{ ...posting, height: 158056 }], at(16), 158060), false, '5 deep is not enough');
  assert.equal(ask([{ ...posting, height: null }], at(16)), false, 'a marker in the mempool is not confirmed');
  assert.equal(ask([{ ...posting, kind: 'B' }], at(16)), false, 'a backup alone does not stand for the day');
  assert.equal(ask([{ ...posting, slot: slot - 1 }], at(16)), false, 'another day\'s posting does not count');
  assert.equal(ask([{ ...posting, tag: '00000000' }], at(16)), false, 'another game\'s does not');
  // and with it the 16:00Z emergency stays away; with nothing confirmed it still comes
  const day = { startMs: dayStartMs, endMs: dayStartMs + 86400000 };
  const verdict = { state: 'pending', why: 'posted by another node; drawn on 0 of 0 seats' };
  assert.equal(guard.emergencyDue({ nowMs: at(16), day, verdict, confirmedAny: ask([posting], at(16)) }).due, false);
  assert.equal(guard.emergencyDue({ nowMs: at(16), day, verdict, confirmedAny: false }).due, true);
});
