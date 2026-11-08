// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ABSENCE CAP (§5A.3, RULED 2026-11-07 kanban #1291, kanban #1325): a census leaves out as absent at most 20 % of the chain census's
// bonded weight, oldest-missed first; a claim over it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggedHash, toHex } from '../src/hash.js';
import { absentFrom, absenceCapKept, absenceWithinCap, weightsOf, presenceWindow, ABSENCE_CAP_BPS } from '../src/presence.js';

const hex = (i) => toHex(taggedHash('TEST/cap-node', Uint8Array.of(i)));
const H = 3600000n;
const w = presenceWindow(100n * H);
// ten nodes, 100 M sat each (1 G in all): 20 % is two nodes' weight
const entries = Array.from({ length: 10 }, (_, i) => ({ pubkey: hex(i), bondSats: 100_000_000n }));
const census = entries.map((e) => e.pubkey);
// nodes 0..4 drawn and missed at three seatings an hour apart, each at its own hours: node i's oldest miss is (i + 3) h before the window's end
const seatings = [];
for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) {
  seatings.push({ roundId: toHex(taggedHash('TEST/cap-round', Uint8Array.of(i, j))), role: 'settlement', closeMs: w.toMs - BigInt(i + 1 + j) * H - BigInt(i) * 1000n,
    drawn: [hex(i), hex(9)], present: [hex(9)], leftOut: [], seated: [hex(9)] });
}

test('the cap is 20 % of the chain census', () => assert.equal(ABSENCE_CAP_BPS, 2000n));

test('the poster leaves out the oldest-missed nodes up to 20 % of the weight, the rest stay in', () => {
  const all = absentFrom({ seatings, census, window: w });
  assert.equal(all.length, 5, 'without weights, all five proven absent');
  const capped = absentFrom({ seatings, census, window: w, weights: weightsOf(entries) });
  assert.deepEqual(capped.map((c) => c.node), [hex(3), hex(4)].sort(), 'the two whose oldest miss is oldest');
  assert.ok(capped.every((c) => Object.keys(c).sort().join() === 'node,proofs'), 'the claim keeps its shape');
  assert.equal(absenceWithinCap(entries, capped).ok, true);
});

test('a claim over 20 % is refused, one at exactly 20 % stands', () => {
  assert.equal(absenceWithinCap(entries, [hex(0), hex(1)]).ok, true, '2 of 10: exactly 20 %');
  const over = absenceWithinCap(entries, [{ node: hex(0) }, { node: hex(1) }, { node: hex(2) }]);
  assert.equal(over.ok, false);
  assert.match(over.why, /above the 20 %/);
  // the weight counts every output of a node
  const two = [...entries, { pubkey: hex(0), bondSats: 1n }];
  assert.equal(absenceWithinCap(two, [hex(0), hex(1)]).ok, false, 'one sat more than 20 %');
});

test('a node above the cap alone stays in, and order is by the oldest miss, then key', () => {
  const big = [{ pubkey: hex(0), bondSats: 300n }, { pubkey: hex(1), bondSats: 100n }, { pubkey: hex(2), bondSats: 600n }];
  const kept = absenceCapKept([{ node: hex(0), sinceMs: 1n }, { node: hex(1), sinceMs: 2n }], weightsOf(big));
  assert.deepEqual(kept, [], 'the oldest (30 %) is over the cap, and the newer stays in with it');
  const tie = absenceCapKept([{ node: hex(1), sinceMs: 5n }, { node: hex(0), sinceMs: 5n }], weightsOf([{ pubkey: hex(0), bondSats: 1n }, { pubkey: hex(1), bondSats: 1n }, ...Array.from({ length: 8 }, (_, i) => ({ pubkey: hex(i + 2), bondSats: 1n }))]));
  assert.deepEqual(tie.map((c) => c.node), [hex(0), hex(1)].sort());
});

test('the client floor: 75 % of the largest census it checked, or of the committed one with the left-out nodes added back', async () => {
  const { censusFloor } = await import('../src/client-committee.js');
  const e = (i, s) => ({ pubkey: taggedHash('TEST/cap-node', Uint8Array.of(i)), bondSats: BigInt(s) });
  const chain = [e(0, 25), e(1, 25), e(2, 25), e(3, 25)];
  assert.equal(censusFloor({ entries: chain.slice(1), out: [hex(0)], seen: [chain] }).ok, true, '75 of 100: at the floor');
  const r = censusFloor({ entries: chain.slice(2), out: [hex(0)], seen: [chain] });
  assert.equal(r.ok, false, '50 of 100');
  assert.equal(r.seenSats, 100n);
  assert.equal(censusFloor({ entries: chain.slice(2), out: [hex(0), hex(1)], seen: [] }).ok, true, 'a client that checked no other census sees only the committed one: nothing to hold it against');
  assert.equal(censusFloor({ entries: [e(2, 25)], out: [hex(0)], seen: [[e(0, 50)]] }).ok, false, '25 of 75: the left-out node added back at the weight another census gives it');
});
