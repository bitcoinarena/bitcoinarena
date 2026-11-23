// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip r2 (a6-2-1): A PEER'S GET /postings ANSWER FOR ENTRY E2 MAY NOT FILL ANOTHER SIGNER'S SLOT WITH THAT SIGNER'S POSTING OF ANOTHER RUN.
// Verifier.publish (verify.js) reads each committee peer's GET /postings?round=&entry=E2 and #keepPeerPosting keeps a record when it decodes, names
// this round and this player, a committee key, and its signature verifies - it never compares the posting's transcriptHash with the agreed run's
// (the hash publish() itself computed a few lines above). A TranscriptPosting names no entry, so an honest signer's genuine posting for entry E1
// of the same player (a reload's second entry, allowed since #1479 - the #1802 case for /results) passes every check under E2. round.putPosting is
// INSERT OR IGNORE keyed (round, entry, signer) (round.js:2704), and publish() skips every key already held (#2729's `tried`), so once one peer
// answered first with those E1 postings, the honest signers' real E2 postings are never kept here. transcriptIsPublished then counts none of
// them, and past final_after finality.js writes §13C VOID: "the transcript was not published by the settlement threshold".
// This is the gap left by #1802's fix (which ties a peer RESULT to its entry): the same tie is missing for postings.
// Safe behaviour: a peer's posting is kept under E2 only if it names E2's agreed transcript, so the honest signers' E2 postings are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Verifier } from '../src/verify.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { encodeTranscriptPosting, transcriptPostingId, joinSignedPosting, transcriptIsPublished } from '../../arena-protocol/src/posting.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { contractFor } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');

test('one committee seat cannot fill the honest signers\' posting slots of E2 with their postings of the same player\'s E1', async () => {
  const secrets = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const EVIL = 6;   // committee seat 6 is the attacker; seats 0..5 are honest
  const c = contractFor(keys, 600000, []);
  const rid = b32(1), player = b32(5);
  const e1 = b32(8), e2 = b32(9);          // the same player's two entries in the round
  const t1 = b32(3), t2 = b32(4);          // their transcripts' hashes
  const posting = (i, transcriptHash) => {
    const p = { roundId: rid, playerPubkey: player, transcriptHash, signerNodePubkey: keys[i], blockHash: b32(7) };
    return joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), secrets[i]));
  };
  // E2'S RUN IS AGREED: five of seven signed it, transcript t2
  const results = keys.slice(0, 5).map((k, i) => {
    const r = { roundId: rid, playerPubkey: player, outcome: DELIVERED, score: 42, transcriptHash: t2, simCoreHash: c.simCoreHash, nodePubkey: k };
    return { bytes: joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), secrets[i])) };
  });
  // THE ATTACKER'S GET /postings?entry=E2: every honest signer's genuine posting of E1 (served publicly at GET /postings?entry=E1)
  const evilAnswer = Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => Buffer.from(posting(i, t1))));
  // AN HONEST PEER'S GET /postings?entry=E2: the honest signers' real postings of E2
  const honestAnswer = Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => Buffer.from(posting(i, t2))));
  const serve = (body) => new Promise((ok) => { const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }); res.end(body);
  }); s.listen(0, '127.0.0.1', () => ok(s)); });
  const evil = await serve(evilAnswer), honest = await serve(honestAnswer);
  // round.js putPosting: INSERT OR IGNORE INTO postings keyed (round_id, entry_id, signer_node_pubkey)
  const kept = [];
  const round = {
    pubkey: b32(0xee), identity: { secret: b32(1) }, now: () => Date.now(),
    get: () => ({ contract: encodeRoundContract(c) }),
    signerNodes: () => keys,
    entriesOf: () => [{ entryId: e1, entry: { playerPubkey: player } }, { entryId: e2, entry: { playerPubkey: player } }],
    results: (r, e) => (hex(e) === hex(e2) ? results : []),
    postings: (r, e) => kept.filter((x) => hex(x.entryId) === hex(e)),
    putPosting: (r, e, who, bytes) => {
      if (kept.some((x) => hex(x.entryId) === hex(e) && hex(x.signerNodePubkey) === hex(who))) return 0;
      kept.push({ entryId: e, signerNodePubkey: who, bytes, seenMs: Date.now() }); return 1;
    },
  };
  const v = new Verifier(round, { peers: [`http://127.0.0.1:${evil.address().port}`, `http://127.0.0.1:${honest.address().port}`] });
  let got;
  try { got = await v.publish(rid, e2); } finally { evil.close(); honest.close(); }
  // what finality.js postedFor reads for E2's agreed transcript
  const counted = transcriptIsPublished({ roundId: rid, playerPubkey: player, transcriptHash: t2, postings: round.postings(rid, e2),
    signerNodes: keys, settlementSlots: c.settlementSlots, verify: (s, m, k) => schnorr.verify(s, m, k) });
  const heldHashes = round.postings(rid, e2).map((x) => hex(x.bytes.subarray(1 + 2 + 32 + 32, 1 + 2 + 32 + 32 + 32)).slice(0, 8));
  console.log('  FACTS:', JSON.stringify({ posted: got.posted, needed: got.needed, counted: counted.posted, heldUnderE2: heldHashes }));
  assert.ok(counted.ok && counted.posted >= 6,
    `the six honest signers posted E2's transcript and an honest peer served those postings, but this seat counts ${counted.posted} of ${counted.needed}: `
    + `seat ${EVIL}'s answer filled their E2 slots with their postings of E1 (transcript ${hex(t1).slice(0, 8)}), and past final_after E2 reads VOID (§13C)`);
});
