// THE CONTRADICTED SIGNERS OF A RE-RUN RESULT, AND THE PROOF THAT SLASHES THEM (§13A, §5A.3B).
//
// §13A: once the committee's re-run is authoritative, "every node that signed
// the contradicted result is slashed (§5A.3)". §5A.3B step 1: "Anyone publishes
// a fraud proof ... the transcript + receipts + replay"; step 2: "the proof is
// mechanically checkable". protocol slash.js holds REPLAY_CONTRADICTS - the
// proof, and `slashHolds`, the check. Steps 3 and 5 (k-of-m arbitration keys
// sign path B, the distribution) are the arbitration set, which does not exist.
//
// THE FIXTURE is the re-run's (f522ad6): seven signer nodes, five sign a rewritten
// score, the holder's replay contradicts it, an objection holds, the holder
// and four signer nodes re-run, and the run is FINAL on the re-run. Each signer node has an
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
import { wait, sevenSignerNodes, object, b32 } from './window-fixture.js';
import { slashOwing, entriesForSlash } from '../src/slash-owing.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const FAST = { finality: { everyMs: 100, rerunMs: 8000 } };

async function reranTo(w, reruns) {
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  assert.equal((await object(w, eid)).status, 201);
  const stop = Date.now() + 8000;
  while (Date.now() < stop && !w.holder.round.reruns(w.rid, eid).some((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey))) await wait(50);
  w.rerunBy('dissents', reruns);
  return eid;
}

const contradictedSigners = (w, eid) => w.holder.round.results(w.rid, eid)
  .map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((r) => toHex(r.nodePubkey) !== toHex(w.holder.round.pubkey))
  .map((r) => toHex(r.nodePubkey)).sort();

test('the re-run makes the result FINAL, and the node files and publishes a REPLAY_CONTRADICTS proof against each of the five who signed the contradicted result - each one slashHolds accepts', async () => {
  const w = await sevenSignerNodes(800, undefined, FAST);
  try {
    const eid = await reranTo(w, 4);
    const stop = Date.now() + 8000;
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 5) await wait(100);
    const state = resultFinality(w.holder.round, w.rid, eid).state;
    const filed = w.holder.round.slashProofs(w.rid, eid);
    const canonical = w.holder.round.canonicalTranscript(w.rid, eid).hash;
    const committee = w.holder.round.signerNodes(w.rid);
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
  const w = await sevenSignerNodes(800, undefined, FAST);
  try {
    const eid = await reranTo(w, 3);
    await wait(1700);
    assert.equal(resultFinality(w.holder.round, w.rid, eid).state, 'SUSPENDED');
    assert.equal(w.holder.round.slashProofs(w.rid, eid).length, 0, 'a proof was filed on a re-run that is not authoritative');
  } finally { await w.close(); }
});

test('a contradicted signer whose advertisement this node does not hold is not accused on a guessed bond', async () => {
  const w = await sevenSignerNodes(800, undefined, FAST);
  try {
    const missing = toHex(schnorr.getPublicKey(w.others[0]));     // one of the five who signed the contradicted result
    w.adverts.delete(missing);
    const eid = await reranTo(w, 4);
    const stop = Date.now() + 8000;
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 4) await wait(100);
    await wait(300);
    const filed = w.holder.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey));
    assert.equal(filed.length, 4, `filed ${filed.length}`);
    assert.equal(filed.includes(missing), false, 'a signer node with no advertisement was accused');
  } finally { await w.close(); }
});

// WHAT THOSE FILED PROOFS OWE (§5A.3, ruled 2026-09-22; door added 2026-09-22).
//
// The proofs above are real: five signers contradicted, each accused on the bond its own
// advertisement names. §5A.3 says where a slashed bond goes, and `/slash-owing` says it for these -
// out of the census at a height THE ASKER names, because the arbitration set names the slashing
// height and a node that picked its own would pick the one that paid it best.
//
// NOTHING HERE SPENDS. Steps 3 and 5 of §5A.3B - the escrow output and MuSig2 over the arbitration
// keys - do not exist in this tree, and the door answers with amounts and names only.
test('the door will not pick the slashing height, and says what the five proofs owe out of the census at the one it is given', async () => {
  const w = await sevenSignerNodes(800, undefined, FAST);
  try {
    const eid = await reranTo(w, 4);
    const stop = Date.now() + 8000;
    while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 5) await wait(100);
    const filed = w.holder.round.slashProofs(w.rid, eid);
    assert.equal(filed.length, 5, 'the fixture filed no proofs to owe anything');

    const at = (entry, q) => fetch(`http://127.0.0.1:${w.holder.port}/slash-owing?round=${toHex(w.rid)}&entry=${entry}${q}`);
    const noHeight = await at(toHex(eid), '');
    const withHeight = await at(toHex(eid), '&height=964950');
    const noProof = await at(toHex(b32(0xee)), '&height=964950');

    // THE ENTRIES THE ROUND ACTUALLY HAS, off the node's own store. This is the arithmetic's input:
    // an empty list here means every offence looks as if it harmed nobody.
    const entries = entriesForSlash(w.holder.round, w.rid);

    // AND THE SPLIT OVER ONE REAL FILED PROOF, with the census a node with a chain view would give:
    // the round's seven seats and three other bonded nodes.
    const seats = w.holder.round.signerNodes(w.rid);
    const others = [b32(0x31), b32(0x32), b32(0x33)];
    const proof = splitSlashEvidence(filed[0].bytes).proof;
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const said = await slashOwing({
      proof, offence: REPLAY_CONTRADICTS, contract, roundIdBytes: w.rid, entries,
      slashHeight: contract.censusHeight + 50, tipHeight: contract.censusHeight + 100,
      censusAt: async () => [...seats, ...others],
      bondSatsOf: async () => 100000n,
    });

    const facts = {
      noHeight: [noHeight.status, await noHeight.text()],
      withHeight: [withHeight.status, await withHeight.text()],
      noProof: [noProof.status, await noProof.text()],
      entriesSeen: entries.length,
      entryPlayers: entries.every((e) => e.playerPubkey instanceof Uint8Array),
      owed: said.ok && {
        toPlayers: String(said.owing.toPlayers), toNodes: String(said.owing.toNodes),
        toDevelopers: String(said.owing.toDevelopers),
        // the seven seats are subtracted; the 75% reaches the three others
        seatsPaid: seats.reduce((a, k) => a + (said.owing.nodes.get(toHex(k)) || 0n), 0n) === 0n,
        othersPaid: others.map((k) => String(said.owing.nodes.get(toHex(k)) || 0n)),
        players: said.owing.players.size, censusSeen: said.owing.censusSeen, seatsOut: said.owing.seatsOut,
      },
    };
    console.log('  FACTS (what the five filed proofs owe):', JSON.stringify(facts, null, 1));
    assert.deepEqual(facts.noHeight[0], 400);
    assert.match(facts.noHeight[1], /this node does not pick one/);
    // A RUN NOBODY FILED AGAINST OWES NOTHING, and is refused before a census is read for it.
    assert.equal(facts.noProof[0], 404);
    assert.match(facts.noProof[1], /filed no slash proof for that run/);
    // AND THIS FIXTURE HAS NO CHAIN, so the door names that rather than inventing a census: the
    // recipients of §5A.3 are read off the chain at the named height or they are not read at all.
    assert.equal(facts.withHeight[0], 409);
    assert.match(facts.withHeight[1], /no chain view for that round/);
    // THE ROUND'S OWN TWO ENTRIES, which is the input the first version of `entriesForSlash` lost.
    assert.equal(facts.entriesSeen, 2);
    assert.deepEqual(facts.owed, {
      toPlayers: '50000', toNodes: '37500', toDevelopers: '12500',
      seatsPaid: true, othersPaid: ['12500', '12500', '12500'],
      players: 1, censusSeen: 10, seatsOut: 7,
    });
  } finally { await w.close(); }
});
