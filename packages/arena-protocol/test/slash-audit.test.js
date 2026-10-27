// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CONTRADICTED AUDIT AS A SLASH PROOF (spec §13A.1, kanban #724, #725). An auditor drawn for a round signs an AUDIT over the round's
// agreed runs; a valid objection later replays one of those runs to another result. The proof names the AUDIT, the entry, the run it
// vouched for, the canonical transcript and the auditor's own bond; the AUDIT's bytes, signature and rows travel beside it.
// slashHoldsOnAudit slashes on exactly that and refuses, by name: a forged AUDIT (another key's signature, altered bytes, a node not
// drawn, signed too late); an AUDIT not contradicted (the objection against another run, the AUDIT over another run, no replay
// verdict); evidence for another round (the entry, the AUDIT); and a bond the auditor did not advertise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVrf, SUITE_SECP256K1_TAI } from '../src/vrf.js';
import { auditAlpha, vrfSecretFor, auditResultsHash, encodeAudit, auditId, AUDIT_LEAD_MS } from '../src/auditor.js';
import {
  encodeAuditSlashProof, decodeAuditSlashProof, auditSlashProofId, joinAuditSlashEvidence, splitAuditSlashEvidence,
  cutAuditSlashEvidence, slashHoldsOnAudit, AUDIT_CONTRADICTED, AUDIT_SLASH_PROOF_BYTES, AUDIT_BYTES,
  encodeSlashProof, slashProofId, affectedEntries, NAMES_ONE_ENTRY,
} from '../src/slash.js';
import { entryId } from '../src/contracts.js';
import { taggedHash, toHex } from '../src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const keyOf = (tag) => { const secret = taggedHash('test/slash-audit', new TextEncoder().encode(tag)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };

const AUDITOR = keyOf('auditor'), OTHER = keyOf('other');
const ROUND = taggedHash('test/round', Uint8Array.of(1)), ROUND_B = taggedHash('test/round', Uint8Array.of(2));
const CLOSE = 5_000_000;
const entryOf = (roundId, player) => ({
  roundId, playerPubkey: b32(player), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 1000000n, feeMsat: 50000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
  stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
});
const ENTRY = entryOf(ROUND, 0xa1), OTHER_ENTRY = entryOf(ROUND, 0xa2), FOREIGN_ENTRY = entryOf(ROUND_B, 0xa1);
const FALSE_RUN = b32(0xf0), TRUE_RUN = b32(0x70), OTHER_RUN = b32(0x55);
const ROWS = [{ entryId: entryId(ENTRY), runId: FALSE_RUN }, { entryId: entryId(OTHER_ENTRY), runId: OTHER_RUN }];
const CANONICAL = b32(0xcc);
const ADVERT = { nodePubkey: AUDITOR.pubkey, bondTxid: b32(0xb0), bondVout: 3 };
// THE AUDITOR IS THE ROUND'S ONLY ELIGIBLE NODE (weight 1 of 1): its own VRF always draws it, as in the seat's tests
const DRAW = { eligible: new Map([[toHex(AUDITOR.pubkey), 1n]]), total: 1n };

/** An AUDIT of `roundId` over `rows`, by `by`, signed by `signer` (the forger's key when it differs). */
function auditOf({ roundId = ROUND, rows = ROWS, by = AUDITOR, signer = by, atMs = CLOSE - AUDIT_LEAD_MS - 1000 } = {}) {
  const a = { roundId, resultsHash: auditResultsHash(rows.map((x) => ({ entryId: x.entryId, resultDigest: x.runId }))), nodePubkey: by.pubkey,
    atMs: BigInt(atMs), vrfProof: vrf.prove(vrfSecretFor(by.secret, secp256k1.Point), auditAlpha(roundId)) };
  return { a, bytes: encodeAudit(a), signature: schnorr.sign(auditId(a), signer.secret) };
}
const proofOf = (audit, over = {}) => ({
  roundId: ROUND, entryId: entryId(ENTRY), playerPubkey: ENTRY.playerPubkey, nodePubkey: AUDITOR.pubkey, auditId: auditId(audit.a),
  contradictedRunId: FALSE_RUN, transcriptHash: CANONICAL, bondTxid: ADVERT.bondTxid, bondVout: ADVERT.bondVout, ...over,
});
const judge = (proof, audit, over = {}) => slashHoldsOnAudit({
  proof, audit: audit.bytes, signature: audit.signature, rows: ROWS, entry: ENTRY, advert: ADVERT, ...DRAW, vrf, verify,
  windowCloseMs: CLOSE, canonicalTranscriptHash: CANONICAL, objectedRunId: FALSE_RUN, replayDiffers: true, ...over,
});

test('valid: the AUDIT vouched for the run a valid objection contradicted - AUDIT_CONTRADICTED, on the auditor\'s own bond, the proof\'s id committed', () => {
  const audit = auditOf();
  const proof = proofOf(audit);
  const got = judge(proof, audit);
  assert.equal(got.slashed, true, got.why);
  assert.equal(got.offence, AUDIT_CONTRADICTED);
  assert.deepEqual([toHex(got.bond.txid), got.bond.vout], [toHex(ADVERT.bondTxid), 3]);
  assert.equal(toHex(got.commitment), toHex(auditSlashProofId(proof)));
  // THE BYTES: a fixed body, its own type byte - never read as the player-result kind, never the same id
  const body = encodeAuditSlashProof(proof);
  assert.equal(body.length, AUDIT_SLASH_PROOF_BYTES);
  assert.equal(audit.bytes.length, AUDIT_BYTES);
  assert.deepEqual(decodeAuditSlashProof(body), proof);
  assert.notEqual(body[0], encodeSlashProof({ roundId: ROUND, playerPubkey: b32(1), nodePubkey: b32(2), transcriptHash: b32(3), signedResultId: b32(4), bondTxid: b32(5), bondVout: 0 })[0]);
  assert.throws(() => decodeAuditSlashProof(encodeSlashProof({ roundId: ROUND, playerPubkey: b32(1), nodePubkey: b32(2), transcriptHash: b32(3), signedResultId: b32(4), bondTxid: b32(5), bondVout: 0 })), /not a slash proof against an AUDIT/);
  // AS PUBLISHED: the proof, the AUDIT, its signature, its rows - split back to the same, and a stream of two cut in two
  const record = joinAuditSlashEvidence(body, audit.bytes, audit.signature, ROWS);
  assert.equal(record.length, AUDIT_SLASH_PROOF_BYTES + AUDIT_BYTES + 64 + 2 + 2 * 64);
  const split = splitAuditSlashEvidence(record);
  assert.equal(toHex(auditSlashProofId(split.proof)), toHex(auditSlashProofId(proof)));
  assert.deepEqual(split.rows.map((x) => toHex(x.runId)), ROWS.map((x) => toHex(x.runId)));
  const again = slashHoldsOnAudit({ proof: split.proof, audit: split.audit, signature: split.signature, rows: split.rows, entry: ENTRY, advert: ADVERT,
    ...DRAW, vrf, verify, windowCloseMs: CLOSE, canonicalTranscriptHash: CANONICAL, objectedRunId: FALSE_RUN, replayDiffers: true });
  assert.equal(again.slashed, true, again.why);
  const two = new Uint8Array([...record, ...record]);
  assert.equal(cutAuditSlashEvidence(two).length, 2);
  assert.equal(cutAuditSlashEvidence(two.subarray(0, record.length + 10)).length, 1, 'a record that does not fit ends the stream');
  // WHO IT HARMED: the one entry its proof names, as for a result contradicted by replay
  assert.ok(NAMES_ONE_ENTRY.includes(AUDIT_CONTRADICTED));
  const harmed = affectedEntries({ offence: AUDIT_CONTRADICTED, playerPubkey: proof.playerPubkey,
    entries: [{ playerPubkey: ENTRY.playerPubkey, activated: true }, { playerPubkey: OTHER_ENTRY.playerPubkey, activated: true }] });
  assert.deepEqual(harmed.affected.map((e) => toHex(e.playerPubkey).slice(0, 2)), ['a1']);
});

test('a forged AUDIT slashes nothing: another key\'s signature, altered bytes, a node not drawn, signed inside the last 30 s', () => {
  const forged = auditOf({ signer: OTHER });                                         // names the auditor, signed by someone else
  assert.match(judge(proofOf(forged), forged).why, /does not stand: the AUDIT is not signed by the node it names/);
  const real = auditOf();
  const altered = { ...real, bytes: encodeAudit({ ...real.a, resultsHash: b32(9) }) }; // the bytes changed under the proof
  assert.match(judge(proofOf(real), altered).why, /not the one this proof names/);
  const reSigned = auditOf({ by: OTHER });                                            // a stranger's own AUDIT, named as the auditor's
  assert.match(judge(proofOf(reSigned, { nodePubkey: OTHER.pubkey }), reSigned, { advert: { ...ADVERT, nodePubkey: OTHER.pubkey } }).why,
    /does not stand: that node may not audit this round/);
  const late = auditOf({ atMs: CLOSE - AUDIT_LEAD_MS + 1 });
  assert.match(judge(proofOf(late), late).why, /does not stand: an AUDIT is signed at least 30 s before the window closes/);
  const notDrawn = { eligible: new Map([[toHex(AUDITOR.pubkey), 1n]]), total: 1n << 80n };   // one weight among 2^80: never drawn
  assert.match(judge(proofOf(real), real, notDrawn).why, /not drawn to audit this round/);
});

test('an AUDIT not contradicted slashes nothing: the objection held against another run, the AUDIT vouched for another, no replay said so', () => {
  const audit = auditOf();
  assert.match(judge(proofOf(audit), audit, { objectedRunId: TRUE_RUN }).why, /no objection held against the run this AUDIT vouched for/);
  assert.match(judge(proofOf(audit), audit, { objectedRunId: null }).why, /no objection held/);
  // THE PROOF CLAIMS THE AUDIT VOUCHED FOR THE CONTRADICTED RUN, AND ITS ROWS SAY IT VOUCHED FOR ANOTHER
  const honest = auditOf({ rows: [{ entryId: entryId(ENTRY), runId: TRUE_RUN }, ROWS[1]] });
  assert.match(judge(proofOf(honest), honest, { rows: [{ entryId: entryId(ENTRY), runId: TRUE_RUN }, ROWS[1]] }).why,
    /vouched for another run of that entry than the one this proof says was contradicted/);
  assert.match(judge(proofOf(honest), honest).why, /the rows attached are not the results the AUDIT vouched for/, 'rows swapped in to match the claim');
  assert.match(judge(proofOf(audit), audit, { replayDiffers: false }).why, /no replay has contradicted/);
  assert.match(judge(proofOf(audit), audit, { replayDiffers: undefined }).why, /no replay has contradicted/);
  assert.match(judge(proofOf(audit), audit, { canonicalTranscriptHash: b32(0xdd) }).why, /not the canonical one/);
});

test('evidence for another round slashes nothing: its entry, its AUDIT, an entry the AUDIT never covered', () => {
  const audit = auditOf();
  assert.match(judge(proofOf(audit, { entryId: entryId(FOREIGN_ENTRY) }), audit, { entry: FOREIGN_ENTRY }).why,
    /vouched for no run of the entry this proof names/);
  const foreignRows = [{ entryId: entryId(FOREIGN_ENTRY), runId: FALSE_RUN }];
  const both = auditOf({ rows: foreignRows });   // an AUDIT whose rows hold the foreign entry, still of ROUND
  assert.match(judge(proofOf(both, { entryId: entryId(FOREIGN_ENTRY) }), both, { rows: foreignRows, entry: FOREIGN_ENTRY }).why,
    /the entry attached is for a different round/);
  const otherRound = auditOf({ roundId: ROUND_B });
  assert.match(judge(proofOf(otherRound), otherRound).why, /the AUDIT attached is for a different round/);
  assert.match(judge(proofOf(audit), audit, { entry: OTHER_ENTRY }).why, /the entry attached is not the one this proof names/);
});

test('the bond is the auditor\'s own advertisement\'s, and checking needs the verifier, the VRF and the round\'s eligible set', () => {
  const audit = auditOf();
  assert.match(judge(proofOf(audit, { bondTxid: b32(0xee) }), audit).why, /the proof names bond .* and the node advertised/);
  assert.match(judge(proofOf(audit), audit, { advert: null }).why, /no advertisement/);
  assert.match(judge(proofOf(audit), audit, { vrf: null }).why, /needs a verifier and a VRF/);
  assert.match(judge(proofOf(audit), audit, { eligible: null }).why, /no eligible set/);
  // AND ITS ID IS NOT THE PLAYER-RESULT KIND'S: the same tag over other bytes
  assert.notEqual(toHex(auditSlashProofId(proofOf(audit))), toHex(slashProofId({ roundId: ROUND, playerPubkey: ENTRY.playerPubkey, nodePubkey: AUDITOR.pubkey,
    transcriptHash: CANONICAL, signedResultId: FALSE_RUN, bondTxid: ADVERT.bondTxid, bondVout: ADVERT.bondVout })));
});
