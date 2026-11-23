// REFUTE #3020 variant 2: the proof is kept in memory only (non-enumerable, JSON.stringify drops it). S1 stands, restarts
// before S2 asked; restored from its database it holds the seating standing but answers ?standing=1 with 404 forever
// (gatewaySeatings.has(key) -> continue, never recomputed), so S2 never stands: the original split, after one restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, list } from './wf1489-r1120b-refute-17-s1-h.mjs';
test('a seat that held a standing seating still serves its signatures after a restart', async () => {
  let s2Down = true;
  const w = world({ dServesTo: ['S1'], down: (name, asker) => asker === 'S2' && s2Down && name !== 'S2' });
  for (let i = 0; i < 2; i++) for (const s of w.seats) await s.pass();
  console.log('before restart: S1', list(w.byName.S1.standing.get(w.k)), 'S2', list(w.byName.S2.standing.get(w.k)));
  w.restart('S1');
  s2Down = false;   // S2's link comes back after S1's restart
  for (let i = 0; i < 4; i++) for (const s of w.seats) await s.pass();
  const s1 = list(w.byName.S1.standing.get(w.k)), s2 = list(w.byName.S2.standing.get(w.k));
  console.log(`after S1 restart: S1 ${s1}, S2 ${s2}`);
  assert.equal(s1, s2, 'every seat builds a round\'s fee table on the same gateway seating (or on none)');
});
