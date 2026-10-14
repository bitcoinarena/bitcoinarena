// THE DUTY TO POST THE ROUNDS 24 H AHEAD (kanban #352): one deterministic node per hour posts hour + 24; a missed slot falls to the next
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
