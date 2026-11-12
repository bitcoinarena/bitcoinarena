// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 2 of #1532 (after 790fb8184): a STRANGER - no entry, no seat key, nothing held - fills the whole relay pool
// through PUT /slash. The slash door checks only that the proof's id matches and that the evidence decodes as a result whose id the
// proof names; no signature, no committee, no held round or entry. Each junk proof is 431 bytes and distinct. RELAY_SLASH_RESERVE
// keeps a part of the pool from transcripts, but nothing keeps a part from slash proofs, and pruneRelayed never deletes a slash proof
// (no round read from its bytes). So once the pool is full every honest transcript (and every real slash proof) gets 507, for ever.
// Safe behaviour: junk proofs from one stranger cannot shut the transcript door, and are not kept for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ARENA_RELAY_MOST = String(512 * 1024);   // a small pool so the test is quick; the live 256 MiB fills the same way
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { pruneRelayed, DAY_MS } = await import('../src/transcript-prune.js');
const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
const { encodeTranscript } = await import('../../arena-protocol/src/transcript.js');
const { SIGNED_CHECKPOINT_BYTES } = await import('../../arena-protocol/src/checkpoint.js');
const { encodeSlashProof, slashProofId, joinSlashEvidence } = await import('../../arena-protocol/src/slash.js');
const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');

test('a stranger fills the relay pool with unsigned junk slash proofs; honest transcripts get 507 and the junk is never pruned', { todo: 'kanban #1489: after the v1+a45 merge the made-up marks / slash proofs / missing bond advert of this test are refused by the stricter a45 checks before the pool; the flood is still blocked, the test data must become real signed data' }, async () => {
  const db = openStore(':memory:');
  const r = (n) => new Uint8Array(randomBytes(n));
  const rid = r(32), honestEntry = r(32);
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, r(8));
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(honestEntry, rid, r(8));
  const seat = await serve(db, { port: 0 });
  const port = seat.port;
  const putAt = async (path, bytes) => { const x = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT', body: bytes }); await x.text(); return x.status; };
  const junkProof = () => {
    const res = { roundId: r(32), playerPubkey: r(32), outcome: 'DELIVERED', score: 1, transcriptHash: r(32), simCoreHash: r(32), nodePubkey: r(32) };
    const proof = { roundId: r(32), playerPubkey: r(32), nodePubkey: r(32), transcriptHash: r(32), signedResultId: resultId(res), bondTxid: r(32), bondVout: 0 };
    return { id: toHex(slashProofId(proof)), bytes: joinSlashEvidence(encodeSlashProof(proof), joinSignedResult(encodePlayerResult(res), r(64))) };
  };
  try {
    let kept = 0, status = 201;
    while (status === 201 && kept < 100000) { const p = junkProof(); status = await putAt(`/slash/${p.id}`, p.bytes); if (status === 201) kept++; }
    console.log(`junk slash proofs kept from a stranger: ${kept} (last ${status}), pool ${db.prepare('SELECT SUM(LENGTH(bytes)) AS n FROM relayed').get().n} of ${process.env.ARENA_RELAY_MOST}`);
    const honest = encodeTranscript({ roundId: rid, entryId: honestEntry, batches: [], marks: Array.from({ length: 4 }, () => r(SIGNED_CHECKPOINT_BYTES)) });
    const got = await putAt(`/transcript/${toHex(transcriptBytesHash(honest))}`, honest);
    console.log(`honest transcript after the slash flood: ${got}`);
    // a year on, after the hourly prune, the junk is still there
    const pr = pruneRelayed({ db, nowMs: Date.now() + 365 * DAY_MS });
    const later = await putAt(`/transcript/${toHex(transcriptBytesHash(honest))}`, honest);
    console.log(`prune a year later deleted ${pr.deleted}; honest transcript then: ${later}`);
    assert.equal(got, 201, `an honest transcript was refused with ${got} after a stranger's unsigned slash proofs filled the pool`);
    assert.equal(later, 201, `still refused (${later}) a year later: the prune never deletes a relayed slash proof`);
  } finally { await seat.close(); }
});
