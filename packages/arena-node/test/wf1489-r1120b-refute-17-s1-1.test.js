// REFUTE #3020 variant 1: D serves its signature to a SEATED GUARDIAN seat (A) only. A holds the seating standing, but the
// ?standing=1 pull skips every seated guardian (seatedHex.includes(node) -> continue), so no other seat ever learns it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, list } from './wf1489-r1120b-refute-17-s1-h.mjs';
test('a standing seating held by a seated-guardian seat reaches the other seats', async () => {
  const w = world({ dServesTo: ['A'] });
  for (let i = 0; i < 4; i++) for (const s of w.seats) await s.pass();
  const got = Object.fromEntries(w.seats.map((s) => [s.g.name, list(s.standing.get(w.k))]));
  console.log('standing per seat:', JSON.stringify(got));
  assert.deepEqual(new Set(Object.values(got)).size, 1, 'every seat holds the same gateway seating (or none)');
});
