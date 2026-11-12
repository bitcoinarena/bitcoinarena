// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1917 (refute 2 of #1532): what the relay's slash door still keeps once it checks the signature, the held round and the
// committee: a committee member's own signed result in a held round is kept (once, counted once); the same signer outside the
// committee, a forged signature and an unheld round are refused; one accused node in one round is held to its share; and the prune
// lets a slash proof go with its round (or, with no round read anywhere, a week after the door took it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ARENA_RELAY_MOST = String(512 * 1024);   // slash share 64 KiB, per accused per round 4 KiB (~9 proofs)
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { pruneRelayed, DAY_MS } = await import('../src/transcript-prune.js');
const { encodeSlashProof, slashProofId, joinSlashEvidence } = await import('../../arena-protocol/src/slash.js');
const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { schnorr } = await import('@noble/curves/secp256k1.js');

const r = (n) => new Uint8Array(randomBytes(n));
const signer = () => { const sk = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey(); return { sk, pk: schnorr.getPublicKey(sk) }; };
function proofOf(rid, who, { forge = false } = {}) {
  const res = { roundId: rid, playerPubkey: r(32), outcome: 'DELIVERED', score: 1, transcriptHash: r(32), simCoreHash: r(32), nodePubkey: who.pk };
  const proof = { roundId: rid, playerPubkey: res.playerPubkey, nodePubkey: who.pk, transcriptHash: res.transcriptHash, signedResultId: resultId(res), bondTxid: r(32), bondVout: 0 };
  const sig = forge ? r(64) : schnorr.sign(resultId(res), who.sk);
  return { id: toHex(slashProofId(proof)), bytes: joinSlashEvidence(encodeSlashProof(proof), joinSignedResult(encodePlayerResult(res), sig)) };
}

test('the slash door keeps a committee member\'s own signed proof of a held round, and refuses the rest', async () => {
  const db = openStore(':memory:');
  const rid = r(32), member = signer(), stranger = signer();
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, r(8));
  db.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(rid, member.pk);
  const seat = await serve(db, { port: 0 });
  const put = async (p) => { const x = await fetch(`http://127.0.0.1:${seat.port}/slash/${p.id}`, { method: 'PUT', body: p.bytes }); await x.text(); return x.status; };
  try {
    const good = proofOf(rid, member);
    assert.equal(await put(good), 201, 'a committee member\'s own signed result was refused');
    assert.equal(await put(good), 201, 'the same proof again');
    const back = await fetch(`http://127.0.0.1:${seat.port}/slash/${good.id}`);
    assert.equal(toHex(new Uint8Array(await back.arrayBuffer())), toHex(good.bytes));
    assert.equal(await put(proofOf(rid, stranger)), 422, 'a signer outside the committee');
    assert.equal(await put(proofOf(rid, member, { forge: true })), 422, 'a signature that is not the accused\'s');
    assert.equal(await put(proofOf(r(32), member)), 422, 'a round this relay does not hold');
    // one accused in one round: its share (4 KiB) fills, then 507; the transcript side is untouched by it
    let kept = 1, status = 201;
    while (status === 201 && kept < 1000) { status = await put(proofOf(rid, member)); if (status === 201) kept++; }
    assert.equal(status, 507);
    assert.ok(kept * good.bytes.length <= 4 * 1024 + good.bytes.length, `kept ${kept} proofs against one accused in one round`);
    const row = db.prepare('SELECT round_id, accused FROM relayed WHERE hash = ?').get(Buffer.from(good.id, 'hex'));
    assert.equal(toHex(new Uint8Array(row.round_id)), toHex(rid));
    assert.equal(toHex(new Uint8Array(row.accused)), toHex(member.pk));
  } finally { await seat.close(); }
});

test('the prune lets a relayed slash proof go with its round, and a row of no round a week after it came', () => {
  const db = openStore(':memory:');
  const rid = r(32), member = signer();
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, Uint8Array.of(1));
  const put = db.prepare('INSERT INTO relayed (hash, bytes, seen_ms) VALUES (?, ?, 0)');
  put.run(r(32), proofOf(rid, member).bytes);      // a proof of a held round (its round read from its bytes)
  put.run(r(32), proofOf(r(32), member).bytes);    // a proof of a round not held here
  put.run(r(32), r(200));                          // bytes of no round at all
  assert.equal(pruneRelayed({ db, nowMs: 1000, keptUntil: () => 500 }).deleted, 1, 'the held round\'s proof goes with its window');
  assert.equal(pruneRelayed({ db, nowMs: 6 * DAY_MS, keptUntil: () => 500 }).deleted, 0, 'the rest stay their week');
  assert.equal(pruneRelayed({ db, nowMs: 8 * DAY_MS, keptUntil: () => 500 }).deleted, 2, 'and then go');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relayed').get().n, 0);
});
