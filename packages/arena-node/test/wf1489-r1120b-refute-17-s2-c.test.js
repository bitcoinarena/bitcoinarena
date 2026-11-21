// control (expected to hold): a census peer M poisons its ?standing=1 answer on the GATEWAY path - the pull is inside try, so S2 goes on to S0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, list } from './wf1489-r1120b-refute-17-s2-h.mjs';
const POISON = '[{"federationId":{"toString":0},"epoch":1090,"guardian":{"toString":0}}]';
test('a census peer\'s malformed ?standing=1 answer on the gateway path is skipped', async () => {
  const w = world({ dServesTo: ['S0'], seatNames: ['M', 'S0', 'S2'], poison: (name, asker, standing) => (name === 'M' && standing ? POISON : null) });
  const errors = [];
  for (const s of w.seats) { const p = s.pass; s.pass = () => p().catch((e) => errors.push(`${s.g.name}: ${e.message}`)); }
  for (let i = 0; i < 4; i++) for (const s of w.seats) await s.pass();
  const got = Object.fromEntries(w.seats.map((s) => [s.g.name, list(s.standing.get(w.k))]));
  console.log('standing per seat:', JSON.stringify(got), 'threw:', errors.length);
  assert.equal(new Set(Object.values(got)).size, 1);
});
