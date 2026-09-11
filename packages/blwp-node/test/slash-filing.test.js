// THE CONTRADICTED SIGNERS OF A RE-RUN RESULT, AND THE PROOF THAT SLASHES THEM (§13A, §5A.3B).
//
// §13A: once the committee's re-run is authoritative, "every node that signed
// the contradicted result is slashed (§5A.3)". §5A.3B step 1: "Anyone publishes
// a fraud proof ... the transcript + receipts + replay"; step 2: "the proof is
// mechanically checkable". protocol slash.js holds REPLAY_CONTRADICTS - the
// proof, and `slashHolds`, the check. Steps 3 and 5 (k-of-m arbitration keys
// sign path B, the distribution) are the arbitration set, which does not exist.
//
// THE FIXTURE is the re-run's (f522ad6): seven seats, five sign a rewritten
// score, the holder's replay contradicts it, an objection holds, the holder
// and four seats re-run, and the run is FINAL on the re-run.
//
// MEASURED FIRST, asserted as it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { toHex } from '../../protocol/src/hash.js';
import { wait, sevenSeats, object } from './window-fixture.js';

async function reranToFinal(w) {
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  assert.equal((await object(w, eid)).status, 201);
  const stop = Date.now() + 8000;
  while (Date.now() < stop && !w.holder.round.reruns(w.rid, eid).some((r) => toHex(r.seatPubkey) === toHex(w.holder.round.pubkey))) await wait(50);
  w.rerunBy('dissents', 4);
  return eid;
}

test('MEASURED: the re-run makes the result FINAL, and the node has filed no slash proof against the five who signed the contradicted result', async () => {
  const w = await sevenSeats(800);
  try {
    const eid = await reranToFinal(w);
    await wait(1700);
    const state = resultFinality(w.holder.round, w.rid, eid).state;
    const door = await fetch(`http://127.0.0.1:${w.holder.port}/slash-proofs?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
    const facts = {
      state,
      contradictedSigners: 5,
      proofsFiled: typeof w.holder.round.slashProofs === 'function' ? w.holder.round.slashProofs(w.rid, eid).length : 0,
      doorStatus: door.status,
    };
    console.log('  FACTS (re-run FINAL, contradicted signers):', JSON.stringify(facts));
    assert.deepEqual(facts, { state: 'FINAL', contradictedSigners: 5, proofsFiled: 0, doorStatus: 404 });
  } finally { await w.close(); }
});
