// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DUTY TO POST THE ROUNDS 24 H AHEAD: one deterministic node per hour posts hour + 24; a missed slot falls to the next
// slot's node; a marker in the chain or mempool says a slot is posted; nobody else posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotOf, slotStartMs, targetWindow, anchorHeight, dutyOrder, dutyMarkerOutput, dutyMarkersOf, itemTag, slotsToPost,
  DUTY_SLOT_MS, DUTY_MISS_GRACE_MS } from '../src/duty.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NET = b32(0x99);
const NODES = Array.from({ length: 14 }, (_, i) => b32(i + 1));

test('slots are UTC hours; slot i posts hour i + 24', () => {
  const t = Date.UTC(2026, 9, 13, 18, 35);
  const s = slotOf(t);
  assert.equal(slotStartMs(s), Date.UTC(2026, 9, 13, 18));
  assert.deepEqual(targetWindow(s), { startMs: Date.UTC(2026, 9, 14, 18), endMs: Date.UTC(2026, 9, 14, 19) });
  // consecutive slots cover consecutive hours: no gap, no overlap
  assert.equal(targetWindow(s).endMs, targetWindow(s + 1).startMs);
});

test('the duty order is the same for everybody, changes by slot, ignores input order and duplicates', () => {
  const a = dutyOrder({ networkId: NET, slot: 500000, nodeKeys: NODES });
  const b = dutyOrder({ networkId: NET, slot: 500000, nodeKeys: [...NODES].reverse().concat(NODES.slice(0, 3)) });
  assert.deepEqual(a.map(toHex), b.map(toHex)); assert.equal(a.length, 14);
  const firsts = new Set(Array.from({ length: 48 }, (_, i) => toHex(dutyOrder({ networkId: NET, slot: 500000 + i, nodeKeys: NODES })[0])));
  assert.ok(firsts.size >= 8, `48 slots spread over ${firsts.size} of 14 nodes`);
});

test('the anchor is the first block whose median time passes the slot start less 3 h, and none before it exists', async () => {
  const slot = slotOf(Date.UTC(2026, 9, 13, 18));
  const want = (slotStartMs(slot) - 3 * 3600000) / 1000;
  const mtps = Array.from({ length: 100 }, (_, h) => want - 50 * 600 + h * 600);       // passes want at h = 51
  assert.equal(await anchorHeight(slot, { mtpAt: async (h) => mtps[h], tip: 99 }), 51);
  assert.equal(await anchorHeight(slot, { mtpAt: async (h) => mtps[h], tip: 50 }), null);
});

test('the marker names the slot and the item, and is read back from a transaction', () => {
  const out = dutyMarkerOutput(500123, 'rps-fed-337ae01a');
  const raw = []; const u32 = (n) => raw.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  u32(2); raw.push(1, ...new Array(32).fill(1)); u32(0); raw.push(0); u32(0xffffffff);
  raw.push(1, ...new Array(8).fill(0), out.script.length, ...out.script); u32(0);
  assert.deepEqual(dutyMarkersOf(Uint8Array.from(raw)), [{ slot: 500123, tag: toHex(itemTag('rps-fed-337ae01a')) }]);
});

test('the duty node posts its own slot; a missed earlier slot only from 5 min into its slot, oldest first; others post nothing', () => {
  const s = 500000, start = slotStartMs(s);
  assert.deepEqual(slotsToPost({ nowMs: start + 60000, onDuty: true, posted: new Set() }), [s], 'in the grace: its own only');
  assert.deepEqual(slotsToPost({ nowMs: start + DUTY_MISS_GRACE_MS, onDuty: true, posted: new Set(Array.from({ length: 20 }, (_, i) => s - 20 + i).filter((x) => x !== s - 2 && x !== s - 1)) }),
    [s - 2, s - 1, s], 'two missed before it, oldest first');
  assert.deepEqual(slotsToPost({ nowMs: start + DUTY_MISS_GRACE_MS, onDuty: false, posted: new Set() }), [], 'not on duty: nothing');
  const all = new Set(Array.from({ length: 21 }, (_, i) => s - 20 + i));
  assert.deepEqual(slotsToPost({ nowMs: start + DUTY_SLOT_MS - 1, onDuty: true, posted: all }), [], 'everything posted: nothing');
});

test('one posting per game per day: the day posts the next day; the first in duty order from the start, each next one an hour later', async () => {
  const { daySlotOf, dayStartMs, targetDay, dayPostDue, DUTY_DAY_MS, anchorHeight } = await import('../src/duty.js');
  const t0 = Date.UTC(2026, 9, 14, 0, 0, 0);
  const d = daySlotOf(t0 + 5 * 3600000);
  assert.equal(dayStartMs(d), t0);
  assert.deepEqual(targetDay(d), { startMs: t0 + DUTY_DAY_MS, endMs: t0 + 2 * DUTY_DAY_MS });
  assert.equal(dayPostDue({ nowMs: t0 + 60000, slot: d, rank: 0, posted: false }), true, 'the first node from the day\'s start');
  assert.equal(dayPostDue({ nowMs: t0 + 60000, slot: d, rank: 1, posted: false }), false, 'the second not yet');
  assert.equal(dayPostDue({ nowMs: t0 + 3600000, slot: d, rank: 1, posted: false }), true, 'the second an hour in');
  assert.equal(dayPostDue({ nowMs: t0 + 5 * 3600000, slot: d, rank: 1, posted: true }), false, 'nobody once the day is posted');
  assert.equal(dayPostDue({ nowMs: t0 + DUTY_DAY_MS, slot: d, rank: 0, posted: false }), false, 'not after the day is over');
  // the anchor of a day: the first block whose median time is past the day's start less 3 h
  const mtp = (h) => (t0 - 4 * 3600000) / 1000 + h * 1200;                  // a block every 20 min from 4 h before the day
  const a = await anchorHeight(d, { mtpAt: async (h) => mtp(h), tip: 100, slotMs: DUTY_DAY_MS });
  assert.equal(a, 4);                                                       // 3 h before = 1 h after the first block: 3 blocks, the first past it is 4
});

// ONLY THE DUTY POSTINGS' ROUNDS ARE ABSENCE PROOFS (§5A.3, kanban #727): a round counts only when its publication carries the day marker of
// a duty item for the day it starts in, and its creator is within the first DUTY_PROOF_RANKS of that day's duty order over the round's
// census; per day, item and kind the first confirmed publication (emergency: the first 3).
test('a duty round: the marker of a duty item for its day, its creator within the first 3 of the day\'s order; the first confirmed posting per day, item and kind', async () => {
  const { dutyMarkerOf, dutyRoundStands, dutyPostingsOf, backupMarkerOutput, daySlotOf, dayStartMs, DUTY_PROOF_RANKS, DUTY_PROOF_ITEMS, DUTY_EMERGENCY_CAP } = await import('../src/duty.js');
  const { serializeSpend } = await import('../src/bond-spend.js');
  const { seriesPublicationOutput } = await import('../src/series.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const keys = Array.from({ length: 10 }, (_, i) => schnorr.getPublicKey(b32(i + 1)));
  const start = BigInt(Date.UTC(2026, 10, 3, 9, 15));                  // the round starts 2026-11-03 09:15Z
  const d = daySlotOf(Number(start)) - 1;                               // posted by day d, the day before
  const order = dutyOrder({ networkId: NET, slot: d, nodeKeys: keys, sw: null });
  const tx = (outs) => serializeSpend({ inputs: [{ txid: b32(7), vout: 0, sequence: 0xffffffff }], outputs: outs, witnesses: [[new Uint8Array(64)]] });
  const sid = b32(0x5e);
  const primary = tx([seriesPublicationOutput(sid), dutyMarkerOutput(d, 'updown-day')]);
  const m = dutyMarkerOf(primary);
  assert.deepEqual({ slot: m.slot, kind: m.kind, app: m.app, item: m.item, emergency: m.emergency }, { slot: d, kind: 'D', app: 'updown', item: 'updown-day', emergency: false });
  assert.equal(dutyMarkerOf(tx([seriesPublicationOutput(sid), dutyMarkerOutput(d, 'rps-fed-337ae01a')])), null, 'an item that is no duty item: no marker');
  assert.equal(dutyMarkerOf(tx([seriesPublicationOutput(sid), backupMarkerOutput(d, 'nextblock-day-emergency')])), null, 'a backup of an emergency item: none');
  assert.equal(dutyMarkerOf(tx([seriesPublicationOutput(sid)])), null);
  assert.equal(dutyMarkerOf(tx([seriesPublicationOutput(sid), backupMarkerOutput(d, 'nextblock-day')])).kind, 'B');
  assert.equal(dutyMarkerOf(tx([seriesPublicationOutput(sid), dutyMarkerOutput(d, 'rps-day-emergency')])).emergency, true);
  assert.equal(Object.keys(DUTY_PROOF_ITEMS).length, 6, 'three apps, a day item and an emergency item each');
  // the round: its creator's rank in the day's order over the census keys
  const round = (rank, over = {}) => ({ networkId: NET, startTimeMs: start, creatorPubkey: order[rank - 1], ...over });
  for (const rank of [1, 2, 3]) { const r = dutyRoundStands({ contract: round(rank), marker: m, orderKeys: keys, sw: null }); assert.equal(r.ok, true, r.why); assert.equal(r.rank, rank); }
  assert.equal(DUTY_PROOF_RANKS, 3);
  assert.match(dutyRoundStands({ contract: round(4), marker: m, orderKeys: keys, sw: null }).why, /rank 4 of its day's duty order; a duty posting is by one of the first 3/);
  assert.match(dutyRoundStands({ contract: round(1), marker: m, orderKeys: keys.filter((k) => k !== order[0]), sw: null }).why, /not in the round's census/);
  assert.match(dutyRoundStands({ contract: round(1), marker: null, orderKeys: keys, sw: null }).why, /no duty marker/);
  assert.match(dutyRoundStands({ contract: { networkId: NET, startTimeMs: start }, marker: m, orderKeys: keys, sw: null }).why, /names no creator/);
  // the day: the marker's slot posts the next day; a round of another day under that marker is none of its posting
  assert.match(dutyRoundStands({ contract: round(1, { startTimeMs: BigInt(dayStartMs(d + 2)) }), marker: m, orderKeys: keys, sw: null }).why, /the round starts on 2026-11-04/);
  assert.equal(dutyRoundStands({ contract: round(1, { startTimeMs: BigInt(dayStartMs(d + 1)) }), marker: m, orderKeys: keys, sw: null }).ok, true, 'the day\'s first moment is in');
  // the first confirmed per day, item and kind; emergency grids up to DUTY_EMERGENCY_CAP; a transaction without a duty marker never
  const mk = (txid, outs) => ({ txid, marker: dutyMarkerOf(tx(outs)) });
  const marked = [mk('a1', [dutyMarkerOutput(d, 'updown-day')]), mk('a2', [dutyMarkerOutput(d, 'updown-day')]), mk('b1', [backupMarkerOutput(d, 'updown-day')]),
    mk('b2', [backupMarkerOutput(d, 'updown-day')]), mk('e1', [dutyMarkerOutput(d, 'updown-day-emergency')]), mk('e2', [dutyMarkerOutput(d, 'updown-day-emergency')]),
    mk('e3', [dutyMarkerOutput(d, 'updown-day-emergency')]), mk('e4', [dutyMarkerOutput(d, 'updown-day-emergency')]), mk('n1', [dutyMarkerOutput(d + 1, 'updown-day')]),
    mk('r1', [dutyMarkerOutput(d, 'rps-day')]), mk('x1', [seriesPublicationOutput(sid)])];
  assert.deepEqual([...dutyPostingsOf(marked)].sort(), ['a1', 'b1', 'e1', 'e2', 'e3', 'n1', 'r1']);
  assert.equal(DUTY_EMERGENCY_CAP, 3);
test('no regular day posting after 12:00 UTC of the posting day, only an emergency grid (kanban #742)', async () => {
  const { dayPostDue, backupPostDue, dayStartMs, DUTY_POST_BY_MS } = await import('../src/duty.js');
  const slot = 20754, at = (h, m = 0) => dayStartMs(slot) + h * 3600000 + m * 60000;   // 2026-10-29, posting 10-30
  assert.equal(DUTY_POST_BY_MS, 12 * 3600000);
  assert.equal(dayPostDue({ nowMs: at(2), slot, rank: 1, posted: false }), true, 'rank 1 at 02:00Z');
  assert.equal(dayPostDue({ nowMs: at(11, 59), slot, rank: 1, posted: false }), true, 'still at 11:59Z');
  assert.equal(dayPostDue({ nowMs: at(12), slot, rank: 1, posted: false }), false, 'not at 12:00Z');
  assert.equal(dayPostDue({ nowMs: at(20, 51), slot, rank: 11, posted: false }), false, 'the 20:51Z repost of 10-29 is not due');
  assert.equal(backupPostDue({ nowMs: at(11, 59), slot, rank: 2, posted: false }), true, 'a backup at 11:59Z');
  assert.equal(backupPostDue({ nowMs: at(12), slot, rank: 2, posted: false }), false, 'no backup from 12:00Z');
});
