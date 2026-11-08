// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1323 (§23A.2 RULED 2026-11-07, #1297): "A cohort or succession founding seats at least f + 1 guardians drawn from the seated guardians of
// existing OPEN federations (an operator may guard at most two OPEN federations), and only the rest from the free pool".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians } from '../src/guardian-founding.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const node = (n, op, { slot = false } = {}) => ({ pubkey: b32(n), txid: b32(0x40 + n), vout: 0, bondSats: 1000000n,
  advert: { operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, ...(slot ? { foundingSlot: true } : {}) } });
const SEED = b32(0x99);
const fresh = Array.from({ length: 10 }, (_, i) => node(1 + i, `fresh${i}`));
const vets = Array.from({ length: 6 }, (_, i) => node(0x20 + i, `vet${i}`, { slot: true }));
const base = { seed: SEED, height: 1000, nominal: 10, bondMinGuardian: 500000n };   // f = 3: four veterans at least

test('#1323 ten fresh bonds do not found alone; f + 1 veterans of OPEN federations are drawn first, the rest from the free pool', () => {
  const guarding = new Set(vets.map((v) => v.advert.operatorId));
  const open1 = new Map(vets.map((v) => [v.advert.operatorId, 1]));
  // ten fresh operators, an OPEN federation exists, no veteran offers a slot: not founded
  const alone = drawGuardians({ ...base, entries: fresh, guardingOpen: guarding, openGuarding: new Map([['someone', 1]]) });
  // veterans with a free slot: four of them first, six fresh
  const mixed = drawGuardians({ ...base, entries: [...fresh, ...vets], guardingOpen: guarding, openGuarding: open1 });
  const vetKeys = new Set(vets.map((v) => toHex(v.pubkey)));
  const drawnVets = mixed.ok ? mixed.drawn.filter((e) => vetKeys.has(toHex(e.pubkey))).length : -1;
  // operators already guarding two OPEN federations are no veterans: too few left
  const two = drawGuardians({ ...base, entries: [...fresh, ...vets], guardingOpen: guarding, openGuarding: new Map(vets.map((v, i) => [v.advert.operatorId, i < 3 ? 2 : 1])) });
  // a veteran without a free founding slot cannot run a second guardian: not counted
  const noSlot = drawGuardians({ ...base, entries: [...fresh, ...vets.map((v) => ({ ...v, advert: { ...v.advert, foundingSlot: false } }))], guardingOpen: guarding, openGuarding: open1 });
  // the network's first founding (no OPEN federation): the draw as before, byte for byte
  const first = drawGuardians({ ...base, entries: fresh, openGuarding: new Map() });
  const before = drawGuardians({ ...base, entries: fresh });
  const got = { alone: [alone.ok, alone.why], mixed: [mixed.ok, drawnVets, mixed.ok ? mixed.drawn.length : 0], twoOpen: two.ok, noSlot: noSlot.ok,
    firstFoundingSame: JSON.stringify(first.drawn.map((e) => toHex(e.pubkey))) === JSON.stringify(before.drawn.map((e) => toHex(e.pubkey))) };
  console.log('  MEASURED #1323:', JSON.stringify(got));
  assert.equal(alone.ok, false); assert.match(alone.why, /at least f \+ 1 = 4 guardians of OPEN federations/);
  assert.equal(mixed.ok, true, mixed.why); assert.equal(drawnVets, 4); assert.equal(mixed.drawn.length, 10);
  assert.ok(mixed.drawn.slice(0, 4).every((e) => vetKeys.has(toHex(e.pubkey))), 'the veterans take the first seats');
  assert.equal(two.ok, false); assert.equal(noSlot.ok, false);
  assert.equal(got.firstFoundingSame, true); assert.equal(before.ok, true);
});
