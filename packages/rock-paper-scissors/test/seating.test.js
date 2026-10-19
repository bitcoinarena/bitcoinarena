// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TABLES OF TWO, SEATED (2026-10-10: "When one player is waiting, one round is being opened. A 2nd player
// joins that round. A 3rd player gets a second round, the 4th player joins that round. 5th player gets the 3rd round and so
// on"; and a pair stays a pair). The client's seatAt, run as the client ships it (between its SEATING markers), over slots of
// tables the way the seats' keeper lays them out - no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('// SEATING BEGIN'), html.indexOf('// SEATING END'));
const seatAt = new Function(code + '\nreturn seatAt;')();

// one slot: `n` tables with fresh ids; players sit in `order`; each asks seatAt with the slot as it stands at its tap (a tap
// in the same instant as another - `together` - sees the same snapshot, and a full table sends it on as the client does)
function playSlot(n, order, { prevSlot, mine, together = [] }) {
  const tables = Array.from({ length: n }, () => ({ id: randomBytes(32).toString('hex'), players: [] }));
  const view = () => tables.map((t) => ({ id: t.id, joined: t.players.length }));
  const seated = {};
  let snapshot = null;
  for (const p of order) {
    const snap = together.includes(p) && snapshot ? snapshot : view();
    if (together.includes(p)) snapshot = snapshot || snap;
    let t = seatAt(snap, { prevSlot, mineId: mine[p] || null });
    let at = t && tables.find((x) => x.id === t.id);
    if (at && at.players.length >= 2) {   // full: the seat refused; the next open table of the slot, one waiting first
      const open = view().filter((x) => x.joined < 2).sort((x, y) => (x.id < y.id ? -1 : 1));
      t = open.find((x) => x.joined === 1) || open[0];
      at = t && tables.find((x) => x.id === t.id);
    }
    if (at) { at.players.push(p); seated[p] = at.id; }
  }
  return { tables, seated, view: view() };
}
const shuffle = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const partners = (tables) => new Set(tables.filter((t) => t.players.length === 2).map((t) => [...t.players].sort().join('+')));

test('1st and 2nd at table 1, 3rd and 4th at table 2, 5th alone at table 3 - and the pairs stay pairs for 25 slots', () => {
  let prev = null, mine = {};
  const first = playSlot(4, ['P1', 'P2', 'P3', 'P4', 'P5'], { prevSlot: prev, mine });
  assert.deepEqual(partners(first.tables), new Set(['P1+P2', 'P3+P4']));
  assert.ok(first.tables.some((t) => t.players.length === 1 && t.players[0] === 'P5'), '5th waits alone');
  prev = first.view; mine = first.seated;
  for (let k = 1; k <= 25; k++) {
    // the pairs come back in any order, at any time of the slot
    const s = playSlot(4, shuffle(['P1', 'P2', 'P3', 'P4', 'P5']), { prevSlot: prev, mine });
    assert.ok(partners(s.tables).has('P1+P2') && partners(s.tables).has('P3+P4'), `slot ${k}: pairs kept: ${JSON.stringify(s.tables.map((t) => t.players))}`);
    prev = s.view; mine = s.seated;
  }
});

test('the lone player is matched by the next one who comes; a player left alone by a leaver is matched the same way', () => {
  let s = playSlot(4, ['P1', 'P2', 'P3', 'P4', 'P5'], { prevSlot: null, mine: {} });
  s = playSlot(4, shuffle(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']), { prevSlot: s.view, mine: s.seated });
  assert.ok(partners(s.tables).has('P5+P6'), `P6 joins P5: ${JSON.stringify(s.tables.map((t) => t.players))}`);
  assert.ok(partners(s.tables).has('P1+P2') && partners(s.tables).has('P3+P4'));
  // P2 leaves: P1 waits alone this slot; the slot after, P1 and a newcomer P7 sit together
  s = playSlot(4, ['P1', 'P3', 'P4', 'P5', 'P6'], { prevSlot: s.view, mine: s.seated });
  s = playSlot(4, ['P1', 'P3', 'P4', 'P5', 'P6', 'P7'], { prevSlot: s.view, mine: s.seated });
  assert.ok(partners(s.tables).has('P1+P7'), `P7 joins P1: ${JSON.stringify(s.tables.map((t) => t.players))}`);
  assert.ok(partners(s.tables).has('P3+P4') && partners(s.tables).has('P5+P6'));
});

test('two newcomers in the same instant see the same table; the second is sent on and nobody is left without a seat', () => {
  // P1 waits; P2 and P3 tap together: one joins P1, the other opens the next table, P4 joins that one
  const s = playSlot(3, ['P1', 'P2', 'P3', 'P4'], { prevSlot: null, mine: {}, together: ['P2', 'P3'] });
  assert.equal(Object.keys(s.seated).length, 4);
  assert.equal(partners(s.tables).size, 2, JSON.stringify(s.tables.map((t) => t.players)));
});

test('more players than tables: everyone else is seated, the rest sit as soon as the next slot has a table', () => {
  const s = playSlot(2, ['P1', 'P2', 'P3', 'P4', 'P5'], { prevSlot: null, mine: {} });
  assert.equal(Object.keys(s.seated).length, 4);
  assert.equal(s.seated.P5, undefined, 'no third table this slot');
});

test('a pair keeps its table when the slot grows or shrinks by a table', () => {
  let s = playSlot(3, ['P1', 'P2', 'P3', 'P4', 'P5'], { prevSlot: null, mine: {} });
  for (const n of [4, 5, 3, 4, 3, 5, 4]) {
    s = playSlot(n, shuffle(['P1', 'P2', 'P3', 'P4', 'P5']), { prevSlot: s.view, mine: s.seated });
    assert.ok(partners(s.tables).has('P1+P2') && partners(s.tables).has('P3+P4'), `${n} tables: ${JSON.stringify(s.tables.map((t) => t.players))}`);
  }
});

test('a table not yet taking entries still counts as a place: a newcomer never takes a pair\'s place for want of counting it', () => {
  // slot before: two pairs at places 0 and 1; now the slot's first table is not assigned yet when the newcomer comes
  const before = [{ id: 'a1', joined: 2 }, { id: 'b1', joined: 2 }, { id: 'c1', joined: 1 }];
  const now = [{ id: 'a2', joined: 0, open: false }, { id: 'b2', joined: 1 }, { id: 'c2', joined: 0 }];
  assert.equal(seatAt(now, { prevSlot: before, mineId: 'c1' }).id, 'c2', 'the lone player sits after the pairs\' places');
  assert.equal(seatAt(now, { prevSlot: before, mineId: 'b1' }).id, 'b2', 'pair 2 at place 2');
});
