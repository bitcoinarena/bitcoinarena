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
// and four seats re-run, and the run is FINAL on the re-run. Each seat has an
// advertisement naming its own bond, as a census gives it.
//
// MEASURED BEFORE (TASKBOOK, b311e15): FINAL, 5 contradicted signers, 0 slash
// proofs filed, no door (404). Now the node files one per contradicted signer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { splitSlashEvidence, slashHolds, slashProofId, REPLAY_CONTRADICTS, SLASH_EVIDENCE_BYTES } from '../../protocol/src/slash.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { toHex } from '../../protocol/src/hash.js';
import { wait, sevenSeats, object } from './window-fixture.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const FAST = { finality: { everyMs: 100, rerunMs: 8000 } };

async function reranTo(w, reruns) {
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  assert.equal((await object(w, eid)).status, 201);
  const stop = Date.now() + 8000;
  while (Date.now() < stop && !w.holder.round.reruns(w.rid, eid).some((r) => toHex(r.seatPubkey) === toHex(w.holder.round.pubkey))) await wait(50);
  w.rerunBy('dissents', reruns);
  return eid;
}

const contradictedSigners = (w, eid) => w.holder.round.results(w.rid, eid)
  .map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((r) => toHex(r.nodePubkey) !== toHex(w.holder.round.pubkey))
  .map((r) => toHex(r.nodePubkey)).sort();

test('the re-run makes the result FINAL, and the node files and publishes a REPLAY_CONTRADICTS proof against each of the five who signed the contradicted result - each one slashHolds accepts', async () => {
  const w = await sevenSeats(800, undefined, FAST);
  try {
    const eid = await reranTo(w, 4);
    const stop = Date.now() + 8000;
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 5) await wait(100);
    const state = resultFinality(w.holder.round, w.rid, eid).state;
    const filed = w.holder.round.slashProofs(w.rid, eid);
    const canonical = w.holder.round.canonicalTranscript(w.rid, eid).hash;
    const committee = w.holder.round.seats(w.rid);
    const checks = filed.map((p) => {
      const got = splitSlashEvidence(p.bytes);
      return slashHolds({ proof: got.proof, signedResult: got.signedResult, advert: w.adverts.get(toHex(got.proof.nodePubkey)),
        committee, canonicalTranscriptHash: canonical, replayDiffers: true });
    });
    const door = await fetch(`http://127.0.0.1:${w.holder.port}/slash-proofs?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
    const served = new Uint8Array(await door.arrayBuffer());
    // THE ROUND'S RELAY - here the holder's own door - keeps each under its id.
    const relayed = [];
    for (const p of filed) {
      const r = await fetch(`http://127.0.0.1:${w.holder.port}/slash/${toHex(slashProofId(splitSlashEvidence(p.bytes).proof))}`);
      relayed.push(r.status === 200 && toHex(new Uint8Array(await r.arrayBuffer())) === toHex(p.bytes));
    }
    const facts = {
      state,
      proofsFiled: filed.length,
      accused: filed.map((p) => toHex(p.nodePubkey)).sort().join() === contradictedSigners(w, eid).join(),
      holderAccused: filed.some((p) => toHex(p.nodePubkey) === toHex(w.holder.round.pubkey)),
      eachSlashes: checks.every((c) => c.slashed && c.offence === REPLAY_CONTRADICTS),
      bondsAreTheirOwn: filed.every((p) => { const pr = splitSlashEvidence(p.bytes).proof; const a = w.adverts.get(toHex(pr.nodePubkey)); return toHex(pr.bondTxid) === toHex(a.bondTxid) && pr.bondVout === a.bondVout; }),
      doorServes: door.status === 200 && served.length === 5 * SLASH_EVIDENCE_BYTES,
      relayKeepsEach: relayed.every(Boolean) && relayed.length === 5,
    };
    console.log('  FACTS (re-run FINAL, slash proofs):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      state: 'FINAL', proofsFiled: 5, accused: true, holderAccused: false, eachSlashes: true,
      bondsAreTheirOwn: true, doorServes: true, relayKeepsEach: true,
    });
  } finally { await w.close(); }
});

test('a re-run short of five files no slash proof: the result is still SUSPENDED and nobody has been contradicted yet', async () => {
  const w = await sevenSeats(800, undefined, FAST);
  try {
    const eid = await reranTo(w, 3);
    await wait(1700);
    assert.equal(resultFinality(w.holder.round, w.rid, eid).state, 'SUSPENDED');
    assert.equal(w.holder.round.slashProofs(w.rid, eid).length, 0, 'a proof was filed on a re-run that is not authoritative');
  } finally { await w.close(); }
});

test('a contradicted signer whose advertisement this node does not hold is not accused on a guessed bond', async () => {
  const w = await sevenSeats(800, undefined, FAST);
  try {
    const missing = toHex(schnorr.getPublicKey(w.others[0]));     // one of the five who signed the contradicted result
    w.adverts.delete(missing);
    const eid = await reranTo(w, 4);
    const stop = Date.now() + 8000;
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 4) await wait(100);
    await wait(300);
    const filed = w.holder.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey));
    assert.equal(filed.length, 4, `filed ${filed.length}`);
    assert.equal(filed.includes(missing), false, 'a seat with no advertisement was accused');
  } finally { await w.close(); }
});
