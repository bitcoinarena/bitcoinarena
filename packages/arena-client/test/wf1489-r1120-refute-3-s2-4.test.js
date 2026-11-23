// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 2), A PEER IN THE SAME BROWSER / A REOPENED BROWSER: `done` is built from the tab's own seed's
// records and keyed by round alone, and a note whose round is in it is removed before the rebuild. So a second player (another phrase)
// or a second order of the same round, whose record was refused, loses its note - and with it the #3086 rebuild - the moment the first
// player's (or order 0's) collect of that round is done.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { store, writeNote, payout, round, NODES, SEED } from './wf1489-r1120-refute-3-s1-harness.js';
import { pageWith } from './wf1489-r1120-refute-3-s2-harness.js';
import { toHex } from '../../arena-protocol/src/hash.js';

function markDone(V, rid, seed, order = 0) {
  PL.saveCollect(V, { roundIdHex: rid, round, invite: 'joininvite', nodes: NODES, seed, order });
  for (const [k, v] of V._m) if (k.startsWith('arena.collect.' + rid)) { const r = JSON.parse(v); if ((Number(r.order) || 0) === order && r.seed === toHex(seed)) V._m.set(k, JSON.stringify({ ...r, done: { at: 1 } })); }
}

test('#3086 peer: another phrase\'s owed payout of the same round is rebuilt though this tab\'s phrase is done with it', async () => {
  const V = store(), S = store(); const rid = '74'.repeat(32), eid = 'ea'.repeat(32);
  const B = new Uint8Array(32).fill(9);
  markDone(V, rid, SEED);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid, seedHex: toHex(B), mine: false });   // a reopened browser: reads every note
  const p = pageWith(V, S, () => payout(180000), { tabSeed: SEED });
  await p.look();
  const b = PL.savedCollects(V, { seed: B }).filter((r) => r.roundIdHex === rid);
  assert.equal(b.length, 1, 'the peer\'s record is rebuilt (note kept: ' + V._m.has('arena.pending.' + rid + '.' + eid) + ')');
});

test('#3086 order: order 1\'s owed payout is rebuilt though order 0 of the same round is done', async () => {
  const V = store(), S = store(); const rid = '75'.repeat(32), eid = 'eb'.repeat(32);
  markDone(V, rid, SEED, 0);
  writeNote(V, S, { roundIdHex: rid, entryIdHex: eid, order: 1 });
  const p = pageWith(V, S, () => payout(180000), { tabSeed: SEED });
  await p.look();
  const o1 = PL.savedCollects(V, { seed: SEED }).filter((r) => r.roundIdHex === rid && r.order === 1);
  assert.equal(o1.length, 1, 'order 1 has its record (note kept: ' + V._m.has('arena.pending.' + rid + '.' + eid) + ')');
});
