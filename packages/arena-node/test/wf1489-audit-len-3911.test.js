// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3911 (closes #3905), RULED 2026-11-28: a published proof against an AUDIT carries the AUDIT's length before it -
// AUDIT_SLASH_PROOF (263, unchanged) || audit_len u16 || AUDIT (188, or 220 with its tick hash) || signature || n || rows.
// Measured before on the 2.0 devnet (round 7ee93200): seats refused every contradicted 220-byte AUDIT, "an AUDIT is 188 bytes, got 220".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinAuditSlashEvidence, splitAuditSlashEvidence, cutAuditSlashEvidence, auditSlashEvidenceBytesOf, encodeAuditSlashProof, slashHoldsOnAudit,
  AUDIT_SLASH_PROOF_BYTES } from '../../arena-protocol/src/slash.js';
import { encodeAudit, decodeAudit } from '../../arena-protocol/src/auditor.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');
const proof = { roundId: b32(1), entryId: b32(2), playerPubkey: b32(3), nodePubkey: b32(4), auditId: b32(5), contradictedRunId: b32(6), transcriptHash: b32(7), bondTxid: b32(8), bondVout: 1 };
const body = encodeAuditSlashProof(proof);
const audit = (tick) => encodeAudit({ roundId: b32(1), resultsHash: b32(9), nodePubkey: b32(4), atMs: 1000n, vrfProof: new Uint8Array(81).fill(7), ...(tick ? { tickHash: b32(10) } : {}) });
const sig = new Uint8Array(64).fill(11);
const rows = [{ entryId: b32(2), runId: b32(6) }, { entryId: b32(12), runId: b32(13) }];
// the layout before the ruling: no length, the AUDIT (188) right after the body
const oldRecord = Buffer.concat([body, audit(false), sig, Buffer.from([0, rows.length]), ...rows.flatMap((r) => [r.entryId, r.runId])]);

test('#3911 a 220-byte AUDIT is joined, split and cut with its length; a 188 one too; an old record still reads', () => {
  const a220 = audit(true), a188 = audit(false);
  assert.equal(a220.length, 220); assert.equal(a188.length, 188);
  const r220 = joinAuditSlashEvidence(body, a220, sig, rows);
  const r188 = joinAuditSlashEvidence(body, a188, sig, rows);
  assert.equal(hex(r220.subarray(0, AUDIT_SLASH_PROOF_BYTES)), hex(body), 'the 263-byte body is unchanged');
  assert.deepEqual([r220[263], r220[264], r188[263], r188[264]], [0, 220, 0, 188]);
  for (const [r, a] of [[r220, a220], [r188, a188], [oldRecord, a188]]) {
    const s = splitAuditSlashEvidence(new Uint8Array(r));
    assert.equal(hex(s.audit), hex(a)); assert.equal(hex(s.signature), hex(sig)); assert.equal(s.rows.length, 2); assert.equal(hex(s.proofBytes), hex(body));
    assert.equal(auditSlashEvidenceBytesOf(new Uint8Array(r)), r.length);
    assert.ok(decodeAudit(s.audit));
  }
  const stream = new Uint8Array(Buffer.concat([oldRecord, r220, r188, oldRecord]));
  assert.deepEqual(cutAuditSlashEvidence(stream).map((x) => x.length), [oldRecord.length, r220.length, r188.length, oldRecord.length]);
});

test('#3911 audit_len other than 188/220 is refused; the length must fit the round\'s protocol', () => {
  const bad = new Uint8Array(joinAuditSlashEvidence(body, audit(true), sig, rows)); bad[264] = 189;
  assert.throws(() => splitAuditSlashEvidence(bad));
  assert.throws(() => joinAuditSlashEvidence(body, new Uint8Array(189), sig, rows));
  const vrf = { verify: () => null }, verify = () => false, eligible = new Map(), total = 1n;
  const at = (a, protocolVersion) => slashHoldsOnAudit({ proof, audit: a, signature: sig, rows, vrf, verify, eligible, total, protocolVersion }).why;
  assert.match(at(audit(false), 28), /protocol 28 takes a 220-byte AUDIT/);
  assert.match(at(audit(true), 27), /protocol 27 takes a 188-byte AUDIT/);
  assert.doesNotMatch(at(audit(true), 36), /takes a/);
  assert.doesNotMatch(at(audit(false), 22), /takes a/);
});
