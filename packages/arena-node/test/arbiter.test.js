// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET SIGNS PATH B (kanban #307, spec 5A.3B steps 1-5). On the re-run fixture (seven signer nodes, five
// sign a rewritten score, an objection holds, the run is FINAL on the re-run and the holder files five REPLAY_CONTRADICTS
// proofs): the arbiter takes a filed proof from the seat's doors (GET /slashes, /slash-proofs, /objection-bundle), REPLAYS
// the objection itself under the round's core and beacon, checks the accused's own signature and its bond, picks the
// slash height, builds path B (nLockTime = slash_height, OP_RETURN = H(proof) || height || hint, the players' escrow, the
// nodes' and the developers' outputs) and 5 of 7 members sign it - each signature its own, checked. A forged proof (the
// evidence's score altered, or a signature not the node's, or a result the replay agrees with) is never judged slashed;
// 4 signatures assemble nothing; the mempool's refusal posts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { wait, sevenSignerNodes, WINDOW_MS } from './window-fixture.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { testNow } from './test-clock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { splitSlashEvidence, SLASH_EVIDENCE_BYTES, joinSlashEvidence } from '../../arena-protocol/src/slash.js';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { arbitrationMembers, judgeProof, buildSlash, memberSign, assemble, post, coreForRound } from '../src/arbiter.js';
import { tweakPoint, combine } from '../src/curve.js';
import { HOSTED } from './plugins/hosted.js';

const FAST = () => ({ finality: { everyMs: 100, rerunMs: 30000 }, endMs: testNow() + 4000 });
const set = arbitrationMembers('regtest');

async function filed() {
  const w = await sevenSignerNodes(WINDOW_MS, undefined, FAST());
  w.sign('dissents', (r) => ({ score: r.score + 1 }));
  const eid = w.runs.dissents.eid;
  const { object } = await import('./window-fixture.js');
  assert.equal((await object(w, eid)).status, 201);
  let stop = Date.now() + 8000;
  while (Date.now() < stop && !w.holder.round.reruns(w.rid, eid).some((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey))) await wait(50);
  w.rerunBy('dissents', 4);
  await w.finalNow('dissents');
  stop = Date.now() + 8000;
  while (Date.now() < stop && w.holder.round.slashProofs(w.rid, eid).length < 5) await wait(100);
  return { w, eid };
}

/** Everything the arbiter reads, off the seat's own doors. */
async function intake(w) {
  const at = `http://127.0.0.1:${w.holder.port}`;
  const list = await (await fetch(`${at}/slashes`)).json();
  const s = list.slashes[0];
  const recs = new Uint8Array(await (await fetch(`${at}/slash-proofs?round=${s.round}&entry=${s.entry}`)).arrayBuffer());
  const records = []; for (let i = 0; i < recs.length; i += SLASH_EVIDENCE_BYTES) records.push(recs.subarray(i, i + SLASH_EVIDENCE_BYTES));
  const evidence = records.find((r) => toHex(splitSlashEvidence(r).proof.nodePubkey) === s.node);
  const bundle = new Uint8Array(await (await fetch(`${at}/objection-bundle?round=${s.round}&entry=${s.entry}`)).arrayBuffer());
  const rid = fromHex(s.round), eid = fromHex(s.entry);
  const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(rid).contract));
  const entry = w.holder.round.entriesOf(rid).find((e) => toHex(e.entryId) === s.entry).entry;
  // THE BEACON OFF THE CHAIN, as the arbiter reads it: the first block past committee_time in the headers
  const view = w.holder.roster.chainFor({ contract, roundIdBytes: rid });
  const named = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  assert.equal(named.ok, true, named.why);
  return { list, s, evidence, bundle, rid, eid, contract, entry, committee: w.holder.round.signerNodes(rid), beacon: named.hash };
}

const judge = (w, x, over = {}) => judgeProof({ evidence: x.evidence, bundle: x.bundle, entry: x.entry, entryId: x.eid, contract: x.contract,
  committee: x.committee, advert: w.adverts.get(x.s.node), bondOutpoint: { txid: w.adverts.get(x.s.node).bondTxid, vout: w.adverts.get(x.s.node).bondVout },
  core: coreForRound(x.contract, x.rid, HOSTED), roundRandomness: x.beacon, ...over });

/** The accused node's bond as the chain would hold it: the output key its advertisement and the network's set build. */
function bondOf(advert, value = 2_000_000n) {
  const internalKey = bondInternalKey({ nodeKey: advert.nodePubkey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const k = bondOutputKey({ nodeKey: advert.nodePubkey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: 100, internalKey }, { tweakPoint, combine });
  return { txid: advert.bondTxid, vout: advert.bondVout, value, script: Uint8Array.from([0x51, 0x20, ...k.outputKey]) };
}

test('a filed proof, re-judged by the arbiter from the seat\'s doors, is signed 5 of 7 into path B; a forged one never; 4 signatures post nothing', async () => {
  const { w } = await filed();
  try {
    const x = await intake(w);
    assert.equal(x.list.slashes.length, 5, 'GET /slashes lists the five filed proofs');
    assert.ok(x.list.slashes.every((s) => s.objection), 'each with the objection that held');
    assert.ok(x.evidence && x.bundle.length > 0, 'GET /slash-proofs and /objection-bundle hand over the evidence');

    // THE JUDGEMENT, HERE
    const verdict = await judge(w, x);
    assert.equal(verdict.slashed, true, verdict.why);
    assert.equal(toHex(verdict.proof.nodePubkey), x.s.node);

    // THE TRANSACTION
    const advert = w.adverts.get(x.s.node);
    // the census at the slash height: the round's seven seats and three more bonded nodes (seats are never paid from a slash)
    const censusNodes = [...[...w.adverts.values()].map((a) => a.nodePubkey), ...[1, 2, 3].map((i) => schnorr.getPublicKey(new Uint8Array(32).fill(0x40 + i)))];
    const slash = buildSlash({ verdict, bond: bondOf(advert), advert: { ...advert, bondScriptTemplateVersion: 1 }, contract: x.contract, roundId: x.rid,
      slashHeight: x.contract.censusHeight + 10, tipHeight: x.contract.censusHeight + 12, censusNodes, seats: x.committee, set });
    assert.equal(slash.ok, true, slash.why);
    const tx = slash.built.tx;
    assert.equal(tx.locktime, x.contract.censusHeight + 10, 'nLockTime = slash_height');
    const commitment = arbitrationCommitmentIn(tx.outputs);
    assert.ok(commitment && toHex(commitment.proofId) === toHex(verdict.proofId) && commitment.slashHeight === x.contract.censusHeight + 10, 'OP_RETURN = H(proof) || slash_height || hint');
    assert.deepEqual(tx.outputs.slice(1).map((o) => o.pays), ['players\' escrow', 'nodes\'', 'developers\'']);
    assert.equal(tx.outputs.slice(1).reduce((s, o) => s + o.value, 0n) + slash.built.fee.sats, 2_000_000n, 'the three outputs and the fee are the bond');

    // EACH MEMBER SIGNS ON ITS OWN; FIVE ASSEMBLE, FOUR DO NOT
    const sigs = set.members.map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) }));
    const five = assemble({ slash, signatures: sigs.slice(0, 5), set });
    assert.equal(five.ok, true, five.why);
    assert.equal(five.signers, 5);
    assert.equal(parseTransaction(fromHex(five.hex)).outputs.length, 4);
    const four = assemble({ slash, signatures: sigs.slice(0, 4), set });
    assert.deepEqual(four, { ok: false, why: '4 valid arbitration signatures, and path B needs 5: nothing is posted' });
    const stranger = schnorr.utils.randomSecretKey();
    const padded = assemble({ slash, signatures: [...sigs.slice(0, 4), { key: schnorr.getPublicKey(stranger), sig: schnorr.sign(slash.sighash, stranger) },
      { key: set.members[5].key, sig: schnorr.sign(new Uint8Array(32).fill(1), set.members[5].secret) }], set });
    assert.equal(padded.ok, false, 'a stranger\'s signature and a member\'s over another message count for nothing');

    // TESTMEMPOOLACCEPT FIRST: a refusal posts nothing
    const calls = [];
    const refuses = async (m, p) => { calls.push(m); return m === 'testmempoolaccept' ? [{ allowed: false, 'reject-reason': 'non-final' }] : 'never'; };
    assert.deepEqual(await post(refuses, five.hex), { ok: false, why: 'the mempool refuses it: non-final', tested: { allowed: false, 'reject-reason': 'non-final' } });
    assert.deepEqual(calls, ['testmempoolaccept'], 'sendrawtransaction was never called');
    const accepts = async (m) => (m === 'testmempoolaccept' ? [{ allowed: true }] : 'ab'.repeat(32));
    assert.deepEqual((await post(accepts, five.hex)).ok, true);

    // FORGED: the evidence's result altered (its score), and re-signed by a stranger; a result the replay agrees with
    const { proof, signedResult } = splitSlashEvidence(x.evidence);
    const body = decodePlayerResult(splitSignedResult(signedResult).body);
    const altered = { ...body, score: body.score + 7 };
    const forgedSig = joinSignedResult(encodePlayerResult(altered), schnorr.sign(resultId(altered), stranger));
    const forged = await judge(w, x, { evidence: joinSlashEvidence(x.evidence.subarray(0, x.evidence.length - signedResult.length), forgedSig) });
    assert.equal(forged.slashed, false);
    assert.match(forged.why, /not signed by the node it names/);
    const honestRecord = w.holder.round.results(x.rid, x.eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
    const honest = await judge(w, x, { evidence: joinSlashEvidence(x.evidence.subarray(0, x.evidence.length - signedResult.length), honestRecord.bytes) });
    assert.equal(honest.slashed, false, 'the holder\'s own honest result: the replay does not contradict it');
    void proof;
  } finally { await w.close(); }
});
