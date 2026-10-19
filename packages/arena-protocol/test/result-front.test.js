// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PRICE ROUND'S PLAYER RESULT CARRIES ITS FRONT (§13 front_*): its own type (0x28, 178 bytes); every other result keeps
// its 168 bytes and id; streams of results, re-runs and slash proofs cut record by record by the type byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePlayerResult, decodePlayerResult, resultId, resultBytesOf, cutSignedResults, joinSignedResult, RESULT_BYTES, RESULT_FRONT_BYTES, FRONT_MODE } from '../src/result.js';
import { encodeRerunResult, decodeRerunResult, joinSignedRerun, splitSignedRerun, cutSignedReruns } from '../src/rerun.js';
import { encodeSlashProof, joinSlashEvidence, splitSlashEvidence, joinRerunSlashEvidence, splitRerunSlashEvidence, cutSlashEvidence, REPLAY_CONTRADICTS } from '../src/slash.js';
import { frontOfRun, FRONT } from '../src/round-result.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = { roundId: b32(1), playerPubkey: b32(2), outcome: 'DELIVERED', score: 18321, transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: b32(5) };
const fronted = { ...base, front: FRONT.BULLS, frontOpenCents: 7500000, frontCloseCents: 7531500, frontMode: FRONT_MODE.LIVE };
const sig = new Uint8Array(64).fill(9);

test('the front rides on its own type; a result without one keeps its bytes and id; a front must follow from its prices', () => {
  const plain = encodePlayerResult(base), withFront = encodePlayerResult(fronted);
  assert.deepEqual([plain.length, plain[0], withFront.length, withFront[0]], [RESULT_BYTES, plain[0], RESULT_FRONT_BYTES, 0x28]);
  assert.deepEqual(withFront.subarray(1, RESULT_BYTES), plain.subarray(1), 'the same fields first');
  assert.deepEqual(decodePlayerResult(withFront), fronted);
  assert.deepEqual(decodePlayerResult(plain), base);
  assert.notDeepEqual(resultId(fronted), resultId(base));
  assert.throws(() => encodePlayerResult({ ...fronted, front: FRONT.BEARS }), /must follow from its open and close/);
  assert.deepEqual([resultBytesOf(plain), resultBytesOf(withFront)], [168, 178]);
});

test('streams cut by type: results, re-runs and slash proofs, the two sizes mixed', () => {
  const a = joinSignedResult(encodePlayerResult(base), sig), b = joinSignedResult(encodePlayerResult(fronted), sig);
  const stream = new Uint8Array([...a, ...b, ...a]);
  assert.deepEqual(cutSignedResults(stream).map((r) => r.length), [232, 242, 232]);
  assert.deepEqual(cutSignedResults(stream.subarray(0, stream.length - 1)).map((r) => r.length), [232, 242], 'a record that does not fit ends the stream');
  const rerun = (result) => joinSignedRerun(encodeRerunResult({ contradictedRunId: b32(7), signedAtMs: 1000n, result }), sig);
  const r1 = rerun(base), r2 = rerun(fronted);
  assert.deepEqual([r1.length, r2.length], [43 + 168 + 64, 43 + 178 + 64]);
  assert.deepEqual(decodeRerunResult(splitSignedRerun(r2).body).result, fronted);
  assert.deepEqual(cutSignedReruns(new Uint8Array([...r2, ...r1])).map((r) => r.length), [285, 275]);
  const proof = encodeSlashProof({ roundId: b32(1), playerPubkey: b32(2), nodePubkey: b32(5), transcriptHash: b32(3), signedResultId: b32(6), bondTxid: b32(8), bondVout: 0, reason: REPLAY_CONTRADICTS });
  const e1 = joinSlashEvidence(proof, a), e2 = joinSlashEvidence(proof, b), e3 = joinRerunSlashEvidence(proof, r2);
  assert.deepEqual([e1.length, e2.length, e3.length], [431, 441, 484]);
  assert.deepEqual(decodePlayerResult(splitSlashEvidence(e2).signedResult.subarray(0, 178)), fronted);
  assert.equal(splitRerunSlashEvidence(e3).signedRerun.length, 285);
  assert.deepEqual(cutSlashEvidence(new Uint8Array([...e1, ...e3, ...e2])).map((r) => r.length), [431, 484, 441]);
});

test('the front a run ended on, from its attested samples; none is SIM', () => {
  const batches = [{ attests: [[0, 0, 7500000, []], [4096, 1, [1, 2], []]] }, { attests: [[8192, 0, 7490000, []], [12288, 0, 7531500, []]] }];
  assert.deepEqual(frontOfRun(batches), { front: FRONT.BULLS, frontOpenCents: 7500000, frontCloseCents: 7531500, frontMode: 1 });
  assert.deepEqual(frontOfRun([{ attests: [] }]), { front: FRONT.FLAT, frontOpenCents: 0, frontCloseCents: 0, frontMode: 2 });
  assert.equal(encodePlayerResult({ ...base, ...frontOfRun([]) }).length, 178, 'a SIM front still encodes');
});
