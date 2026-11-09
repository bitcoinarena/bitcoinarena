// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1331 part 2 (§13A.1 RULED 2026-11-07 (2)): "An AUDIT counts when it is on the round's publication_relays[] by the cutoff". The seat's sweep
// asks each closed audited round's relays once (audit-seat.js fromRelays), before final_after, when its settlement reads the auditors it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaySweep } from '../src/audit-seat.js';

const row = (n, c) => ({ round_id: new Uint8Array(32).fill(n), contract: new TextEncoder().encode(JSON.stringify(c)) });
const decode = (b) => JSON.parse(new TextDecoder().decode(b));
const windowsOf = (c) => ({ closeMs: c.closeMs, finalAfterMs: c.closeMs + 60000 });
const audited = (c) => !!c.audited;

test('#1331 the sweep asks each closed audited round\'s relays once; an open one waits, one without auditors or relays is never asked', async () => {
  const asked = [];
  const fromRelays = async (rid, relays) => { asked.push([rid[0], relays.length]); return { asked: relays.length, taken: rid[0] === 1 ? 1 : 0 }; };
  const rows = [
    row(1, { audited: true, publicationRelays: ['https://a', 'https://b'], closeMs: 1000 }),   // closed: asked
    row(2, { audited: true, publicationRelays: ['https://a'], closeMs: 5000 }),                 // open at 2000: waits
    row(3, { audited: false, publicationRelays: ['https://a'], closeMs: 1000 }),                // no auditors
    row(4, { audited: true, publicationRelays: [], closeMs: 1000 }),                            // no relays
    row(5, { audited: true, publicationRelays: ['https://a'], closeMs: -4000000 }),             // an hour past final_after: let be
  ];
  const swept = new Set();
  const first = await relaySweep({ rows, nowMs: 2000, swept, decode, audited, windowsOf, fromRelays });
  assert.deepEqual(first, [{ round: '01'.repeat(32), asked: 2, taken: 1 }]);
  assert.deepEqual(asked, [[1, 2]]);
  // the next pass: round 1 not again; round 2 once it closed
  const second = await relaySweep({ rows, nowMs: 6000, swept, decode, audited, windowsOf, fromRelays });
  assert.deepEqual(second.map((x) => x.round), ['02'.repeat(32)]);
  assert.deepEqual(asked, [[1, 2], [2, 1]]);
  assert.equal((await relaySweep({ rows, nowMs: 7000, swept, decode, audited, windowsOf, fromRelays })).length, 0, 'asked twice');
});

test('#1331 at most `max` rounds a pass; a relay read that throws is said and not asked again', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1, { audited: true, publicationRelays: ['https://a'], closeMs: 0 }));
  const swept = new Set();
  const out = await relaySweep({ rows, nowMs: 10, swept, decode, audited, windowsOf, max: 2, fromRelays: async (rid) => { if (rid[0] === 2) throw new Error('down'); return { asked: 1, taken: 0 }; } });
  assert.equal(out.length, 2);
  assert.match(out[1].why, /the relays could not be read: down/);
  const next = await relaySweep({ rows, nowMs: 10, swept, decode, audited, windowsOf, max: 10, fromRelays: async () => ({ asked: 1, taken: 0 }) });
  assert.deepEqual(next.map((x) => x.round[1]), ['3', '4', '5']);
});
