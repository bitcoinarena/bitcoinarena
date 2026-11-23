// REFUTE #3020 variant 3: one census seat M answers ?standing=1 with n junk signatures naming the seated guardians. S1 pulls M's
// junk, then S0's good proof, stands - but its own proof is signed.filter(seated).slice(0, 2n): the junk pushes D's signature out,
// and the receiver slices to n again. A seat that asks S1 (S0 gone) gets a proof that does not stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, list, standingSeating, verify, fid, EPOCH } from './wf1489-r1120b-refute-17-s1-h.mjs';
test('the signatures a standing seat serves on ?standing=1 make the seating stand', async () => {
  let s0Up = true;
  const w = world({ dServesTo: ['S0'], seatNames: ['M', 'S0', 'S1', 'S2'], junkFrom: 'M',
    down: (name, asker) => name === 'S0' && !s0Up && asker !== 'S0' });
  for (const n of ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'S0', 'S1']) await w.byName[n].pass();
  const held = w.byName.S1.standing.get(w.k);
  console.log('S0', list(w.byName.S0.standing.get(w.k)), 'S1', list(held));
  assert.ok(held, 'S1 stands (pulled S0)');
  const r = await w.fetchFor('S2')(`https://s2.example/gateway-seating?federation=${fid}&epoch=${EPOCH}&standing=1`);
  const proof = (await r.json()).slice(0, 4);
  const st = standingSeating({ signed: proof, federationId: fid, epoch: EPOCH, seated: w.guardians.map((g) => g.hex), threshold: 3, verify });
  console.log('S1 proof guardians:', (await (await w.fetchFor('S2')(`https://s2.example/gateway-seating?federation=${fid}&epoch=${EPOCH}&standing=1`)).json()).map((x) => x.guardian.slice(0, 4) + (x.signature === '00'.repeat(64) ? '(junk)' : '')).join(' '), '->', st.ok, st.why);
  s0Up = false;
  for (let i = 0; i < 4; i++) await w.byName.S2.pass();
  console.log('S2 after asking S1 (S0 gone):', list(w.byName.S2.standing.get(w.k)));
  assert.equal(list(w.byName.S2.standing.get(w.k)), list(held), 'S2 stands on S1\'s proof');
});
