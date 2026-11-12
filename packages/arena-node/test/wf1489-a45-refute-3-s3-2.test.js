// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute-3 s3 #2 (fixture reserve-payout-fixture.js)
// THE FOURTH COPY OF #1807: reserve-payout.js sign() puts a guardian seat's commit answer on the list under whatever id it names (server.js reads
// /reserve-payout/commit's JSON as { id: Number(j.commitment.id), ... }, nothing checked). One guardian seat of seven that commits under another's id
// (or the coordinator's) makes the coordinator's own shareHere throw "two commitments for participant N are one commitment"; the throw leaves sign()
// before `left` drops anyone, the next pass asks the same peers in the same order, and the passed proposal is never paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT } from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

function forge(w, k, id) {
  const orig = w.seats[k].api.commit;
  w.seats[k].api.commit = async (b) => { const r = await orig(b); return r && r.ok ? { ...r, commitment: { ...r.commitment, id } } : r; };
}

async function passes(w) {
  const out = [];
  let state = null;
  for (const h of [500, 503, 506]) {
    let r;
    try { [r] = await w.seats[0].api.round({ height: h }); } catch (e) { r = { state: 'THREW', why: e.message }; }
    state = r ? r.state : null;
    out.push(r ? `${r.state}${r.why ? ` (${r.why})` : ''}` : 'nothing');
    if (state === PAYOUT.PAID) break;
  }
  return { state, out };
}

for (const [label, id] of [['another guardian\'s id (3)', 3], ['the coordinator\'s own id (1)', 1]]) {
  test(`wf1489 a45 refute-3 s3 #2: one guardian seat committing under ${label} does not stop a passed proposal's payout`, async () => {
    const w = world();
    forge(w, 1, id);   // seat 1 (FROST id 2) is the first peer asked, so it is on every list
    const { state, out } = await passes(w);
    console.log(`  FACTS: ${out.join(' | ')}`);
    assert.equal(state, PAYOUT.PAID, out.join(' | '));
  });
}

test('wf1489 a45 refute-3 s3 #2 honest: seven honest guardian seats pay on the first pass', async () => {
  const w = world();
  const { state, out } = await passes(w);
  console.log(`  FACTS: ${out.join(' | ')}`);
  assert.equal(state, PAYOUT.PAID, out.join(' | '));
});
