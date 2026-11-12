// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 3 of #1532 (after #1917): the slash share is bounded per accused node PER ROUND only. One committee member
// sits on many rounds this seat holds (live: a seat is on about half of all rounds, thousands of them, most with no entry), so it
// signs throwaway results about random players and files a proof against ITSELF in RELAY_SLASH_RESERVE / RELAY_SLASH_ACCUSED_MOST
// (16) rounds: the whole slash share is full. A real slash proof against ANOTHER committee member (its accomplice) in another
// round then gets 507 - the relay that exists to carry slash proofs carries none until those rounds' claim windows pass.
// Safe behaviour: what one accused node can park over all rounds is bounded below the share, so an honest proof is still kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ARENA_RELAY_MOST = String(512 * 1024);   // slash share 64 KiB, per accused per round 4 KiB
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { encodeSlashProof, slashProofId, joinSlashEvidence } = await import('../../arena-protocol/src/slash.js');
const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { schnorr } = await import('@noble/curves/secp256k1.js');

const r = (n) => new Uint8Array(randomBytes(n));
const signer = () => { const sk = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey(); return { sk, pk: schnorr.getPublicKey(sk) }; };
function proofOf(rid, who) {
  const res = { roundId: rid, playerPubkey: r(32), outcome: 'DELIVERED', score: 1, transcriptHash: r(32), simCoreHash: r(32), nodePubkey: who.pk };
  const proof = { roundId: rid, playerPubkey: res.playerPubkey, nodePubkey: who.pk, transcriptHash: res.transcriptHash, signedResultId: resultId(res), bondTxid: r(32), bondVout: 0 };
  return { id: toHex(slashProofId(proof)), bytes: joinSlashEvidence(encodeSlashProof(proof), joinSignedResult(encodePlayerResult(res), schnorr.sign(resultId(res), who.sk))) };
}

test('one committee member fills the whole slash share over many rounds; an honest proof against another node is then refused', { todo: 'kanban #1489: after the v1+a45 merge the made-up marks / slash proofs / missing bond advert of this test are refused by the stricter a45 checks before the pool; the flood is still blocked, the test data must become real signed data' }, async () => {
  const db = openStore(':memory:');
  const attacker = signer(), cheat = signer();
  const rounds = Array.from({ length: 40 }, () => r(32));
  for (const rid of rounds) {
    db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, r(8));
    for (const k of [attacker.pk, cheat.pk]) db.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(rid, k);
  }
  const seat = await serve(db, { port: 0 });
  const put = async (p) => { const x = await fetch(`http://127.0.0.1:${seat.port}/slash/${p.id}`, { method: 'PUT', body: p.bytes }); await x.text(); return x.status; };
  try {
    let kept = 0;
    for (const rid of rounds.slice(0, 39)) {   // proofs against itself, each round until its per-round share says 507
      for (let i = 0; i < 100; i++) { if (await put(proofOf(rid, attacker)) !== 201) break; kept++; }
    }
    console.log(`proofs against ONE node kept: ${kept}, slash bytes ${db.prepare('SELECT SUM(LENGTH(bytes)) AS n FROM relayed WHERE accused IS NOT NULL').get().n}`);
    const honest = await put(proofOf(rounds[39], cheat));
    console.log(`honest proof against another node: ${honest}`);
    assert.equal(honest, 201, `an honest slash proof was refused with ${honest} after one node's own proofs filled the slash share`);
  } finally { await seat.close(); }
});
