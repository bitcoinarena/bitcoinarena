// REFUTE #3020 (skeptic 2, lens: the attacker guardian's PLAIN read, the retry path): D serves its valid signature to S1 and, to S2,
// a JSON answer whose federationId has an own "toString" key. gatherSeatings pushes the plain read into `signed` unchecked and runs
// standingSeating on it outside any try: String() throws, S2's whole pass aborts before the ?standing=1 pull, on every retry. S1 holds
// the seating standing and serves its proof; S2 never asks for it - the original split, one seated guardian deciding per seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, list } from './wf1489-r1120b-refute-17-s2-h.mjs';
const POISON = '{"federationId":{"toString":0},"epoch":1090,"guardian":{"toString":0}}';
test('a seated guardian\'s malformed plain answer does not keep a seat from the standing gateway seating', async () => {
  const w = world({ dServesTo: ['S1'], poison: (name, asker, standing) => (name === 'D' && asker === 'S2' && !standing ? POISON : null) });
  const errors = [];
  for (const s of w.seats) { const p = s.pass; s.pass = () => p().catch((e) => errors.push(`${s.g.name}: ${e.message}`)); }   // as server.js: gatherSeatings().catch(() => {})
  for (let i = 0; i < 4; i++) for (const s of w.seats) await s.pass();
  const got = Object.fromEntries(w.seats.map((s) => [s.g.name, list(s.standing.get(w.k))]));
  console.log('standing per seat:', JSON.stringify(got), 'passes that threw:', errors.length, errors.slice(0, 2).join(' / '));
  assert.notEqual(got.S1, 'none', 'S1 holds the seating standing');
  assert.equal(got.S2, got.S1, 'every seat builds a round\'s fee table on the same gateway seating (or on none)');
});
