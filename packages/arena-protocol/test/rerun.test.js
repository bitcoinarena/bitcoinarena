// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE'S RE-RUN COUNT - rerun.js on its own (kanban #146, first surface; plan comment 187, Go 2026-10-05). It decides
// the "re-run agreed" and "re-run not agreed" outcome paths: finality.js pays the agreed re-run's result, or hands the run to
// noQuorumOutcome (VOID or FORFEIT). Until now it ran only inside arena-node's tests (67.5% lines / 58.3% branches from
// protocol's own suite). Signatures are real BIP-340 from the noble library the nodes load - the only cross-package import.
//
// Read from the source before this file, and measured here first: a signer node that signed TWO DIFFERENT re-run outcomes
// for one contradicted run was counted once, for whichever record came first, so the same set of records in another order
// gave another answer - two seats holding one set could decide two ways, one paying the re-run, the other refunding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import {
  encodeRerunResult, decodeRerunResult, rerunResultId, joinSignedRerun, splitSignedRerun, rerunIsAgreed, runOf,
  RERUN_BYTES, RERUN_SIGNATURE_BYTES, SIGNED_RERUN_BYTES,
} from '../src/rerun.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const KEYS = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const NODES = KEYS.map((k) => schnorr.getPublicKey(k));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const ROUND = b32(0x31), PLAYER = b32(0x32), CONTRADICTED = b32(0x33);
const result = (over = {}) => ({ roundId: ROUND, playerPubkey: PLAYER, outcome: 'FAILED', score: 7,
  transcriptHash: b32(0x34), simCoreHash: b32(0x35), nodePubkey: b32(0), ...over });
const body = (i, over = {}, contradictedRunId = CONTRADICTED) =>
  ({ contradictedRunId, signedAtMs: 1790000000000n, result: result({ ...over, nodePubkey: NODES[i] }) });
const signedBy = (i, over = {}, contradictedRunId = CONTRADICTED, secret = KEYS[i]) => {
  const x = body(i, over, contradictedRunId);
  return { bytes: joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secret, new Uint8Array(32))) };
};
const count = (records, o = {}) => rerunIsAgreed({ roundId: ROUND, playerPubkey: PLAYER, contradictedRunId: CONTRADICTED,
  records, signerNodes: NODES, slots: 7, verify, ...o });
const A = { outcome: 'FAILED', score: 7 }, B = { outcome: 'DELIVERED', score: 900 };

// THE FIRST CHECK (plan 187): one set of records gives one answer, whatever their order.
test('a node that signed two different outcomes does not make the answer depend on the order of the records', () => {
  const honest = [0, 1, 2, 3].map((i) => signedBy(i, A));
  const two = [signedBy(4, A), signedBy(4, B)];
  const aFirst = count([...honest, ...two]);
  const bFirst = count([...honest, ...[...two].reverse()]);
  assert.deepEqual({ ok: bFirst.ok, agreed: bFirst.agreed }, { ok: aFirst.ok, agreed: aFirst.agreed },
    `the same records decided two ways: ${aFirst.why || 'agreed'} / ${bFirst.why || 'agreed'}`);
  assert.deepEqual({ ok: aFirst.ok, agreed: aFirst.agreed }, { ok: false, agreed: 4 }, 'a node that signed two outcomes was counted');
  // with a fifth honest node the outcome is agreed either way, and the two-faced node is still not counted
  const five = count([...honest, signedBy(5, A), ...two]);
  assert.deepEqual({ ok: five.ok, agreed: five.agreed }, { ok: true, agreed: 5 });
  assert.deepEqual({ ok: count([...honest, signedBy(5, A), ...[...two].reverse()]).ok }, { ok: true });
  // the same record twice is one signature, not two outcomes
  assert.equal(count([...honest, signedBy(4, A), signedBy(4, A)]).agreed, 5);
});

test('refused by name: ids not 32 bytes, no verifier, no committee, a committee size with no threshold', () => {
  const why = 'a re-run is counted for one round, one player and one contradicted run';
  for (const o of [{ roundId: b32(1).subarray(0, 31) }, { playerPubkey: undefined }, { contradictedRunId: 'x' }])
    assert.deepEqual(count([], o), { ok: false, agreed: 0, why });
  assert.deepEqual(count([], { verify: undefined }), { ok: false, agreed: 0, why: 'counting a re-run needs a verifier, and none was injected' });
  assert.deepEqual(count([], { signerNodes: [] }), { ok: false, agreed: 0, why: 'this round has no assigned committee to re-run it' });
  assert.deepEqual(count([], { signerNodes: undefined }), { ok: false, agreed: 0, why: 'this round has no assigned committee to re-run it' });
  assert.deepEqual(count([], { slots: 4 }), { ok: false, agreed: 0, why: 'no committee threshold for 4 slots' });
});

test('records that do not count: undecodable, off the committee, another round, player or contradicted run, a bad or throwing signature', () => {
  const four = [0, 1, 2, 3].map((i) => signedBy(i, A));
  const fifth = (rec, o) => count([...four, rec], o).agreed;
  assert.equal(fifth(signedBy(4, A)), 5, 'the fifth honest record does not count');
  assert.equal(fifth({ bytes: signedBy(4, A).bytes.subarray(1) }), 4, 'a short record counted');
  const wrongType = Uint8Array.from(signedBy(4, A).bytes); wrongType[0] ^= 1;
  assert.equal(fifth({ bytes: wrongType }), 4, 'a record of another type counted');
  assert.equal(fifth(undefined), 4);
  assert.equal(fifth(signedBy(4, A), { signerNodes: NODES.slice(0, 4).concat(NODES.slice(5)) }), 4, 'a node off the committee counted');
  assert.equal(fifth(signedBy(4, { ...A, roundId: b32(0x41) })), 4, 'another round counted');
  assert.equal(fifth(signedBy(4, { ...A, playerPubkey: b32(0x42) })), 4, 'another player counted');
  assert.equal(fifth(signedBy(4, A, b32(0x43))), 4, 'another contradicted run counted');
  assert.equal(fifth(signedBy(4, A, CONTRADICTED, KEYS[5])), 4, 'a record signed by another key counted');
  const throwing = (s, m, k) => { if (hex(k) === hex(NODES[4])) throw new Error('bad'); return verify(s, m, k); };
  assert.equal(fifth(signedBy(4, A), { verify: throwing }), 4, 'a record whose check threw counted');
  assert.equal(count(undefined).agreed, 0);
});

test('the outcome paths: 5 of 7 agreed with its run and result; 4 of 7, a 3 + 3 split and nothing are not', () => {
  const agreed = count([0, 1, 2, 3, 4].map((i) => signedBy(i, A)).concat([signedBy(5, B), signedBy(6, B)]));
  assert.equal(agreed.ok, true);
  assert.deepEqual({ agreed: agreed.agreed, needed: agreed.needed }, { agreed: 5, needed: 5 });
  assert.equal(hex(agreed.runId), hex(runOf(result(A))));
  assert.deepEqual({ outcome: agreed.result.outcome, score: agreed.result.score }, A);
  assert.deepEqual(count([0, 1, 2, 3].map((i) => signedBy(i, A))),
    { ok: false, agreed: 4, needed: 5, why: '4 of 5 committee signer nodes have re-run the contradicted result to one outcome' });
  assert.deepEqual(count([0, 1, 2].map((i) => signedBy(i, A)).concat([3, 4, 5].map((i) => signedBy(i, B)))),
    { ok: false, agreed: 3, needed: 5, why: '3 of 5 committee signer nodes have re-run the contradicted result to one outcome' });
  assert.deepEqual(count([]), { ok: false, agreed: 0, needed: 5, why: '0 of 5 committee signer nodes have re-run the contradicted result to one outcome' });
});

test('a 2-of-2 committee agrees at 2 and not at 1', () => {
  const two = { signerNodes: NODES.slice(0, 2), slots: 2 };
  const got = count([signedBy(0, A), signedBy(1, A)], two);
  assert.deepEqual({ ok: got.ok, agreed: got.agreed, needed: got.needed }, { ok: true, agreed: 2, needed: 2 });
  assert.deepEqual(count([signedBy(0, A)], two), { ok: false, agreed: 1, needed: 2, why: '1 of 2 committee signer nodes have re-run the contradicted result to one outcome' });
  assert.equal(count([signedBy(0, A), signedBy(1, B)], two).ok, false);
});

test('encoding: a round trip, a pinned record id, one run for two signers of one outcome, and the length refusals', () => {
  const x = body(0, A);
  const bytes = encodeRerunResult(x);
  assert.equal(bytes.length, RERUN_BYTES);
  assert.deepEqual(decodeRerunResult(bytes), x);
  assert.equal(hex(rerunResultId(x)), 'b61d626e63bb987a7b49f9a8a3a0abec955dc199be1a372e30e27712f19f8f3d');
  assert.equal(hex(runOf(x.result)), '718424c7815bb0e63b21da9ff3db2e6ff2b6fe2a45954134b866ba243d159fcf');
  assert.equal(hex(runOf(body(3, A).result)), hex(runOf(x.result)), 'two signers of one outcome are two runs');
  assert.notEqual(hex(runOf(body(3, B).result)), hex(runOf(x.result)));
  assert.throws(() => decodeRerunResult(Uint8Array.from([...bytes, 0])), /trailing bytes/);
  assert.throws(() => decodeRerunResult(Uint8Array.from([bytes[0] ^ 1, ...bytes.subarray(1)])), /not a re-run result/);
  assert.throws(() => decodeRerunResult(Uint8Array.from([bytes[0], bytes[1], bytes[2] ^ 1, ...bytes.subarray(3)])), /protocol version/);
  const sig = new Uint8Array(RERUN_SIGNATURE_BYTES).fill(7);
  const joined = joinSignedRerun(bytes, sig);
  assert.equal(joined.length, SIGNED_RERUN_BYTES);
  assert.deepEqual(splitSignedRerun(joined), { body: bytes, signature: sig });
  assert.throws(() => joinSignedRerun(bytes.subarray(1), sig), { message: `a re-run result is ${RERUN_BYTES} bytes, got ${RERUN_BYTES - 1}` });
  assert.throws(() => joinSignedRerun(bytes, sig.subarray(1)), { message: 'a signature is 64 bytes, got 63' });
  assert.throws(() => splitSignedRerun(joined.subarray(1)), { message: `a signed re-run result is ${SIGNED_RERUN_BYTES} bytes` });
  assert.throws(() => splitSignedRerun(undefined), { message: `a signed re-run result is ${SIGNED_RERUN_BYTES} bytes` });
});
