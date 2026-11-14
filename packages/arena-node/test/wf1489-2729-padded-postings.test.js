// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 (gossip): ONE PEER'S GET /postings ANSWER COSTS AT MOST ONE SIGNATURE CHECK PER COMMITTEE KEY.
// Verifier.publish (verify.js) reads each peer's GET /postings up to PEER_BODY_MAX_BYTES (16 MiB) and hands every SIGNED_POSTING_BYTES (227)
// slice to #keepPeerPosting, which schnorr-verifies each one that names this round, this player and a committee key - with no limit per key and
// no skip for a key whose posting is already held (#1634 put exactly that limit on GET /results: "one check per committee key per answer").
// One committee seat answering 16 MiB of copies of its own posting with junk signatures (~74,000 records) costs every honest seat ~74,000
// BIP-340 verifies in one synchronous loop, on its one thread, in every publish() - settleTheStakes runs publish() for every agreed run of
// the round before it builds the settlement, and a finality tick runs it again. Safe: one check per committee key per answer (the same
// bound as /results), so a padded answer costs at most the committee's size in verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Verifier } from '../src/verify.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { encodeTranscriptPosting, joinSignedPosting, SIGNED_POSTING_BYTES } from '../../arena-protocol/src/posting.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { contractFor } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ANSWER_BYTES = 4 * 1024 * 1024;   // a quarter of what the cap lets through, to keep the red run short

test('a peer padding GET /postings with copies of one posting does not cost a signature check per copy', async () => {
  const secrets = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const c = contractFor(keys, 600000, []);
  const rid = b32(1), eid = b32(9), player = b32(5), transcriptHash = b32(4);
  // FIVE OF SEVEN SIGNED ONE RUN: the run is agreed, so publish() goes on to read the peers' postings
  const results = keys.slice(0, 5).map((k, i) => {
    const r = { roundId: rid, playerPubkey: player, outcome: DELIVERED, score: 10, transcriptHash, simCoreHash: c.simCoreHash, nodePubkey: k };
    return { bytes: joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), secrets[i])) };
  });
  // THE ATTACKER, committee seat 6: its own posting's bytes over and over, each with a junk signature
  const one = encodeTranscriptPosting({ roundId: rid, playerPubkey: player, transcriptHash, signerNodePubkey: keys[6], blockHash: b32(3) });
  const n = Math.floor(ANSWER_BYTES / SIGNED_POSTING_BYTES);
  const answer = Buffer.alloc(n * SIGNED_POSTING_BYTES);
  for (let i = 0; i < n; i++) {
    const rec = joinSignedPosting(one, new Uint8Array(randomBytes(64)));
    answer.set(rec, i * SIGNED_POSTING_BYTES);
  }
  const evil = await new Promise((ok) => { const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': answer.length }); res.end(answer);
  }); s.listen(0, '127.0.0.1', () => ok(s)); });
  const kept = [];
  const round = {
    pubkey: b32(0xee), identity: { secret: b32(1) }, now: () => Date.now(),
    get: () => ({ contract: encodeRoundContract(c) }),
    signerNodes: () => keys,
    entriesOf: () => [{ entryId: eid, entry: { playerPubkey: player } }],
    results: () => results,
    postings: () => kept,
    putPosting: (r, e, who, bytes) => { kept.push({ signerNodePubkey: who, bytes, seenMs: Date.now() }); return 1; },
  };
  const v = new Verifier(round, { peers: [`http://127.0.0.1:${evil.address().port}`] });
  const t0 = Date.now();
  const got = await v.publish(rid, eid);
  const ms = Date.now() - t0;
  evil.close();
  console.log('  FACTS:', JSON.stringify({ records: n, ms, posted: got.posted, why: got.why }));
  assert.equal(got.posted, 0);
  assert.ok(ms < 2000, `one peer's padded /postings answer (${n} copies, junk signatures) held publish() ${ms} ms on the seat's thread: a verify per copy`);
});
