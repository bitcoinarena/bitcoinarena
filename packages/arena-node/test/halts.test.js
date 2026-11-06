// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT OBSERVED AND PROVEN BY THE SEATS (spec §23A.5 "How a halt is proven", RULED 2026-10-14), the seat's part:
// rehearsal 17's federation of four - g2 and g3 gone at session 41 - observed by five of nine census seats, and the liquidation
// listed from the proof alone (no HALTED record exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts, wsSessionCount, sessionReading, clockStep } from '../src/halts.js';
import { signHaltObservation, encodeHaltObservation, decodeHaltObservation } from '../../arena-protocol/src/halt-proof.js';
import { createLiquidations } from '../src/liquidations.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const fid = toHex(taggedHash('TEST/fed', Uint8Array.of(1)));
const record = { federationId: taggedHash('TEST/fed', Uint8Array.of(1)), guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), endpoint: `wss://g${i}` })) };
const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1, bytes: Uint8Array.of(0xcd, 0xef) } : null),
  haltOf: () => null, haltedFederations: () => [] };
const clocks = { abandonBlocks: 10, claimBlocks: 10, drainBlocks: 100 };

function seatOf(s, world) {
  return createHalts({ records, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, s.secret), ownKey: s.pub,
    height: async () => world.tip, ask: async (ep) => { const i = Number(ep.slice(-1)); if (world.down.has(i)) throw new Error('down'); return world.session; },
    post: async (o) => { world.posted.push(o); } });
}

test('each seat signs once the last session has not moved for abandon_blocks; five of nine prove the halt; the liquidation lists it', async () => {
  const world = { tip: 330, session: 40, down: new Set(), posted: [] };
  const all = seats.map((s) => seatOf(s, world));
  for (const h of all) await h.observe();                  // session 40 seen at 330
  world.session = 41; world.tip = 341; world.down = new Set([2, 3]);
  for (const h of all) await h.observe();                  // 41 first seen at 341, g2 and g3 gone
  world.tip = 350;
  for (const h of all) assert.equal((await h.observe())[0].signed, undefined, '9 blocks of no progress: nothing signed');
  world.tip = 351;
  const rows = [];
  for (const h of all.slice(0, 5)) rows.push((await h.observe())[0]);
  assert.deepEqual(rows.map((r) => [r.session, r.firstHeight, r.answering, r.signed]), Array(5).fill([41, 341, 2, true]));
  // seat 0 takes the four others' observations as its peers post them
  const me = all[0];
  for (const o of world.posted.slice(1, 5)) assert.equal(me.take(o).ok, true);
  const p = me.proofOf(fid);
  assert.ok(p, 'five of nine at session 41 for abandon_blocks: the halt stands');
  assert.deepEqual([p.session, p.haltHeight, p.observers, p.abandoned.length, p.answered.length], [41, 341, 5, 2, 2]);
  const liq = createLiquidations({ records, clocks, verify, halts: me });
  const l = liq.list();
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].haltHeight, l[0].haltRecord, l[0].haltProof.session, l[0].haltProof.abandoned.length, l[0].liquidatesAt], [341, null, 41, 2, 351]);
  assert.equal(l[0].record, 'cdef', 'no HALTED record behind a proven halt: the record held is listed, for the remainder\'s payees');
});

test('a stranger, a forged observation and a later session do not make or keep a halt', async () => {
  const world = { tip: 341, session: 41, down: new Set(), posted: [] };
  const me = seatOf(seats[0], world);
  await me.observe(); world.tip = 352; await me.observe();
  const stranger = key('stranger');
  const odd = createHalts({ records, censusSeats: () => [stranger.pub], clocks, verify, sign: (h) => schnorr.sign(h, stranger.secret), ownKey: stranger.pub,
    height: async () => world.tip, ask: async () => 41, post: async (o) => world.posted.push(o) });
  await odd.observe(); world.tip = 363; await odd.observe();
  assert.equal(world.posted.length, 2, "the seat and the stranger each signed once");
  const r = me.take(world.posted[world.posted.length - 1]);
  assert.equal(r.ok, false); assert.match(r.why, /not an active seat/);
  const forged = { ...world.posted[0], signature: '00'.repeat(64) };
  assert.match(me.take(forged).why, /not signed by its seat/);
  assert.equal(me.proofOf(fid), null, 'one seat alone proves nothing');
});

// KEPT ACROSS A RESTART (kanban #326, measured 2026-10-21: T2's seats rolled at 157,238 held no observation and counted
// abandon_blocks again): what a seat signed, and the session and first_height it saw, are read back at start.
test('a restart keeps the observations and the clock: a seat restarted mid-way signs at abandon_blocks from the first sighting', async () => {
  const world = { tip: 341, session: 41, down: new Set([2, 3]), posted: [] };
  let disk = null;
  const seat = () => createHalts({ records, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, seats[0].secret),
    ownKey: seats[0].pub, height: async () => world.tip, ask: async (ep) => { const i = Number(ep.slice(-1)); if (world.down.has(i)) throw new Error('down'); return world.session; },
    post: async (o) => { world.posted.push(o); }, load: () => (disk === null ? [] : JSON.parse(disk)), save: (v) => { disk = JSON.stringify(v); } });
  const a = seat();
  await a.observe();                                       // 41 first seen at 341
  assert.deepEqual(JSON.parse(disk).seen[fid], { session: 41, firstHeight: 341, heard: true, rule: 2, at: JSON.parse(disk).seen[fid].at });
  world.tip = 346;
  const b = seat();                                        // restarted at 346: the clock is the one seen at 341
  assert.deepEqual([b.seen(fid).session, b.seen(fid).firstHeight], [41, 341]);
  world.tip = 351;
  const row = (await b.observe())[0];
  assert.deepEqual([row.session, row.firstHeight, row.signed], [41, 341, true]);
  const c = seat();                                        // and what it signed is still held after the next restart
  assert.equal(c.list(fid).length, 1);
  // a higher session after a restart starts the clock again, as before
  world.session = 42; world.tip = 352;
  assert.deepEqual((await c.observe()).map((r) => [r.session, r.firstHeight, r.signed]), [[42, 352, undefined]]);
  // the first format (a list of observations alone) still reads
  disk = JSON.stringify(JSON.parse(disk).observations);
  assert.equal(seat().list(fid).length, 1);
  // a session-0 view stored before `heard` was kept names its peers' session too (the seats rolled 23:49Z stored one)
  disk = JSON.stringify({ observations: world.posted.slice(0, 1).map((o) => o), seen: { [fid]: { session: 0, firstHeight: 345, at: 1 } } });
  const old = createHalts({ records, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, seats[1].secret),
    ownKey: seats[1].pub, height: async () => world.tip, ask: async () => { throw new Error('down'); }, post: async () => {},
    load: () => JSON.parse(disk), save: () => {} });
  world.tip = 360;
  // ONE PEER'S OBSERVATION IS NOT TAKEN (kanban #1158): a seat that heard nothing names a session only when need - 1 of its peers do
  assert.deepEqual((await old.observe()).map((r) => [r.session, r.firstHeight]), [[0, 345]], 'one peer\'s 41 is not taken');
});

// A SEAT THAT NEVER HEARD A GUARDIAN (kanban #326, measured 2026-10-21 23:5xZ): T2's guardians exit once consensus times out, so a
// seat rolled after that saw no session at all - it names the session its peers' signed observations name, from its own first_height.
test('a seat that never heard a guardian names its peers\' session from its own first_height; one it hears itself restarts the clock', async () => {
  const world = { tip: 341, session: 41, down: new Set(), posted: [] };
  const all = seats.map((s) => seatOf(s, world));
  for (const h of all.slice(0, 4)) await h.observe();     // four seats hear session 41 at 341
  world.down = new Set([0, 1, 2, 3]); world.tip = 345;
  const late = all[8];
  assert.deepEqual((await late.observe()).map((r) => [r.session, r.firstHeight]), [[0, 345]], 'nothing heard, no peer observation yet');
  world.tip = 353;
  for (const h of all.slice(0, 4)) assert.equal((await h.observe())[0].signed, true);
  for (const o of world.posted) late.take(o);
  const row = (await late.observe())[0];
  assert.deepEqual([row.session, row.firstHeight, row.answering, row.signed], [41, 345, 0, undefined], 'the peers\' 41, from its own 345');
  world.tip = 357;
  assert.deepEqual((await late.observe()).map((r) => [r.session, r.firstHeight, r.signed]), [[41, 345, true]]);
  for (const o of world.posted.slice(-1)) assert.equal(all[0].take(o).ok, true);
  for (const o of world.posted.slice(1, 4)) all[0].take(o);
  const p = all[0].proofOf(fid);
  assert.ok(p, 'five at session 41: the late seat counts');
  assert.deepEqual([p.session, p.haltHeight, p.observers], [41, 345, 5]);
  // a seat that heard a guardian keeps its own session: a peer's higher one does not move it
  const heard = all[0];
  assert.equal(heard.seen(fid).session, 41);
});

test('a guardian session count is asked over its endpoint, a local override taken first', async () => {
  const opened = [];
  class FakeWS { constructor(u) { opened.push(u); this.h = {}; setTimeout(() => this.h.open(), 1); }
    on(e, f) { this.h[e] = f; } send(m) { const j = JSON.parse(m); setTimeout(() => this.h.message(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: 5078 })), 1); } close() {} }
  const n = await wsSessionCount('wss://test-host.example/guardian-1', { overrides: 'wss://test-host.example/guardian-1=ws://127.0.0.1:32221/', WebSocketImpl: FakeWS });
  assert.equal(n, 5078); assert.deepEqual(opened, ['ws://127.0.0.1:32221/']);
  await assert.rejects(wsSessionCount('', { WebSocketImpl: FakeWS }), /no guardian endpoint/);
});

// THE DOOR READS THE BODY AS TEXT (kanban #326, measured 2026-10-22 on the T2 observers at 157,261: every seat held only its own
// observation - POST /halt-observations parsed String(bytes), "123,34,...", and refused every peer's as not JSON)
test('POST /halt-observations reads its JSON body: a malformed observation is refused by halts.take, not as unreadable JSON', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const seat = await serve(openStore(join(mkdtempSync(join(tmpdir(), 'halt-door-')), 'node.db')), { port: 0, chainTip: async () => 157261 });
  try {
    const r = await fetch(`http://127.0.0.1:${seat.port}/halt-observations`, { method: 'POST', body: JSON.stringify({ observation: '00', signature: '00' }) });
    const why = await r.text();
    assert.equal(r.status, 400);
    assert.match(why, /not a halt observation/, why);
  } finally { await seat.close(); }
});

// KANBAN #1158: ONE GUARDIAN'S SESSION COUNT PROVES NO HALT. Seven guardians, one of them answering session 2^31; the six honest ones move
// one session a block. Before, every seat took the highest answer, its clock froze at 2^31, and after abandon_blocks every seat signed
// an observation at it: the quorum met, "slow, not halted" never fired, a running federation proven HALTED.
const fid7 = toHex(taggedHash('TEST/fed', Uint8Array.of(7)));
const record7 = { federationId: taggedHash('TEST/fed', Uint8Array.of(7)), guardians: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ peerKey: peer(i), endpoint: `wss://g${i}` })) };
const records7 = { list: () => [{ federation: fid7 }], recordOf: (f) => (f === fid7 ? { record: record7, status: 'OPEN', height: 1, bytes: Uint8Array.of(1) } : null), haltOf: () => null, haltedFederations: () => [] };
const LIE = 2 ** 31;
function seat7(s, world, { load = () => [] } = {}) {
  return createHalts({ records: records7, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, s.secret), ownKey: s.pub,
    height: async () => world.tip, load, save: () => {},
    ask: async (ep) => { const i = Number(ep.slice(-1)); if (world.down.has(i)) throw new Error('down'); return world.liar === i ? LIE : world.session; },
    post: async (o) => { world.posted.push(o); } });
}

test('#1158 one guardian answering session 2^31 proves no halt of a running federation', async () => {
  const world = { tip: 330, session: 500, down: new Set(), posted: [], liar: 6 };
  const all = seats.map((s) => seat7(s, world));
  for (let i = 0; i < 15; i++) { for (const h of all) await h.observe(); world.tip++; world.session++; }
  for (const o of world.posted) all[0].take(o);
  const p = all[0].proofOf(fid7);
  console.log(`#1158 measure: 7 guardians, 1 answers 2^31, the federation runs 15 blocks (abandon_blocks 10) -> seat clock at ${all[0].seen(fid7).session}, ${world.posted.length} observations signed, halt ${p ? `PROVEN at session ${p.session}` : 'not proven'}`);
  assert.equal(world.posted.length, 0, 'no seat signs an observation');
  assert.equal(p, null);
  assert.equal(all[0].seen(fid7).session, 514, 'the clock follows the six honest guardians');
});

test('#1158 a seat that never heard a guardian does not take one lying seat\'s session, and a seat that hears them voids a proof above its reading', async () => {
  const world = { tip: 330, session: 500, down: new Set(), posted: [], liar: null };
  const heard = seat7(seats[0], world);
  await heard.observe();
  const liar = seats[8];
  const lie = signHaltObservation({ federationId: record7.federationId, session: LIE, firstHeight: 300, height: 330, answering: [], observer: liar.pub }, (h) => schnorr.sign(h, liar.secret));
  const lieJson = { observation: toHex(encodeHaltObservation(lie)), signature: toHex(lie.signature) };
  // four seats that reach no guardian take the lie
  const deaf = { ...world, down: new Set([0, 1, 2, 3, 4, 5, 6]), posted: world.posted };
  const quiet = seats.slice(4, 8).map((s) => seat7(s, deaf));
  for (const q of quiet) { q.take(lieJson); await q.observe(); }
  deaf.tip = 341;
  for (const q of quiet) await q.observe();
  for (const o of [lieJson, ...world.posted]) heard.take(o);
  world.tip = 341; await heard.observe();
  const atLie = world.posted.map((o) => decodeHaltObservation(Buffer.from(o.observation, 'hex'))).filter((o) => o.session === LIE).length;
  const p = heard.proofOf(fid7);
  console.log(`#1158 measure: one lying seat's observation at 2^31, four seats that hear no guardian -> ${atLie} of them sign 2^31; a seat hearing the guardians at ${heard.seen(fid7).session}: halt ${p ? `PROVEN at ${p.session}` : 'not proven'}`);
  assert.equal(atLie, 0, 'the deaf seats do not take one peer\'s session');
  assert.equal(p, null);
});

test('#1158 sessionReading and clockStep: the (f + 1)-th highest; a view of the old rule read again; a halted federation\'s clock kept', () => {
  assert.equal(sessionReading([500, 500, 500, 500, 500, 500, LIE], 7), 500, 'f = 2: the third highest');
  assert.equal(sessionReading([LIE, 500], 4), 500, 'f = 1: the second highest');
  assert.equal(sessionReading([693], 4), null, 'one answer of four reads nothing');
  assert.equal(sessionReading([], 4), null);
  // a view stored under the old rule at a liar's session is read again at the first reading
  assert.deepEqual(clockStep({ session: LIE, firstHeight: 300, heard: true }, { reading: 510, tip: 340 }), { session: 510, firstHeight: 340, heard: true, rule: 2 });
  // a halted federation (T2: no guardian answers; T: one of four) keeps its session and first_height under the new rule
  const t2 = { session: 783, firstHeight: 157262, heard: true };
  assert.equal(clockStep(t2, { reading: null, tip: 159383 }), t2);
  // the old rule's view at the reading's own session keeps its first_height
  assert.deepEqual(clockStep({ session: 783, firstHeight: 157262, heard: true }, { reading: 783, tip: 159383 }), { session: 783, firstHeight: 157262, heard: true, rule: 2 });
  // a seat that never heard: need - 1 peers at 783 name it; fewer name nothing
  assert.equal(clockStep(null, { reading: null, peerSessions: Array(46).fill(783), need: 23, tip: 159000 }).session, 783);
  assert.equal(clockStep(null, { reading: null, peerSessions: [LIE], need: 5, tip: 159000 }).session, 0);
});

// KANBAN #1223 (audit 2 #1204 FED-A2): the "slow, not halted" void (#1158) applied only while EVERY kept observation was below the session
// this seat saw - so one census seat's observation at a huge session switched it off, and a federation that had stalled and recovered was
// proven HALTED again from its old halt height (liquidation listed, spent sets published). Now a proof at session S is void whenever this
// seat itself saw the federation past S, whatever else is held.
test('#1223 a recovered federation stays not halted when one seat posts an observation at a huge session', async () => {
  const { haltObservationId } = await import('../../arena-protocol/src/halt-proof.js');
  const world = { tip: 330, session: 40, down: new Set(), posted: [] };
  const all = seats.map((s) => seatOf(s, world));
  for (const h of all) await h.observe();
  world.session = 41; world.tip = 341; world.down = new Set([2, 3]);
  for (const h of all) await h.observe();
  world.tip = 351;
  for (const h of all.slice(0, 5)) await h.observe();
  const me = all[0];
  for (const o of world.posted.slice(1, 5)) me.take(o);
  assert.ok(me.proofOf(fid), 'the stall at 41 is proven');
  // the federation recovers: sessions move again, and this seat sees them
  world.session = 45; world.down = new Set(); world.tip = 360;
  await me.observe();
  assert.equal(me.proofOf(fid), null, 'a later session seen here voids it (#1158)');
  // one census seat posts an observation at a huge session, for both variants of the number
  for (const session of [0x7fffffff, 46]) {
    const liar = seats[8];
    const o = { federationId: record.federationId, session, firstHeight: 0, height: 360, answering: [], observer: liar.pub };
    const signed = { observation: toHex(encodeHaltObservation(o)), signature: toHex(schnorr.sign(haltObservationId(o), liar.secret)) };
    me.take(signed);
    assert.equal(me.proofOf(fid), null, `a recovered federation proven halted again by one observation at session ${session}`);
  }
});
