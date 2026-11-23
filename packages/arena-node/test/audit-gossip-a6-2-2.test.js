// kanban #3362: the card's test (audit gossip a6-2-2)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip r2 (a6-2-2): A PEER'S GET /reruns ANSWER FOR ENTRY E2 MAY NOT FILL ANOTHER SIGNER'S RE-RUN SLOT WITH ITS RE-RUN OF ANOTHER RUN.
// Verifier.rerun (verify.js) reads each committee peer's GET /reruns?round=&entry=E2 and #keepPeerRerun keeps a record when it names this round
// and player, a committee key, and its signature verifies - never that it re-runs E2's contradicted run (x.contradictedRunId), though rerun()
// was called with it. A re-run names no entry, so an honest signer's genuine re-run of the same player's E1 (contradicting E1's run) passes.
// round.putRerun keeps a held record that counted (signed within the tolerance of its arrival) over any later one (INSERT OR IGNORE,
// round.js:2723), so the honest signers' real E2 re-runs are never kept here, and rerunIsAgreed (which does filter on contradictedRunId)
// counts none of them: no re-run threshold by end + 1205 s is §13C's VOID for E2. Same gap in #1802's entry tie as /postings (a6-2-1).
// Safe behaviour: a peer's re-run is kept under E2 only if it re-runs E2's contradicted run, so the honest E2 re-runs are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Verifier } from '../src/verify.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun, splitSignedRerun, decodeRerunResult } from '../../arena-protocol/src/rerun.js';
import { withinTolerance } from '../../arena-protocol/src/window.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { contractFor } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');

test('one committee seat cannot fill the honest signers\' re-run slots of E2 with their re-runs of the same player\'s E1', async () => {
  const secrets = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const c = contractFor(keys, 600000, []);
  const rid = b32(1), player = b32(5);
  const e1 = b32(8), e2 = b32(9);
  const run1 = b32(0x31), run2 = b32(0x32);   // the contradicted runs of E1 and of E2
  const rerun = (i, contradictedRunId, transcriptHash, score) => {
    const x = { contradictedRunId, signedAtMs: BigInt(Date.now()),
      result: { roundId: rid, playerPubkey: player, outcome: DELIVERED, score, transcriptHash, simCoreHash: c.simCoreHash, nodePubkey: keys[i] } };
    return joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secrets[i]));
  };
  // the attacker (seat 6) answers GET /reruns?entry=E2 with every honest signer's genuine re-run of E1 (served at GET /reruns?entry=E1)
  const evilAnswer = Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => Buffer.from(rerun(i, run1, b32(3), 7))));
  // an honest peer answers with the honest signers' real re-runs of E2
  const honestAnswer = Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => Buffer.from(rerun(i, run2, b32(4), 42))));
  const serve = (body) => new Promise((ok) => { const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }); res.end(body);
  }); s.listen(0, '127.0.0.1', () => ok(s)); });
  const evil = await serve(evilAnswer), honest = await serve(honestAnswer);
  const kept = [];
  const counted = (b, seen) => { try { return withinTolerance(decodeRerunResult(splitSignedRerun(b).body).signedAtMs, seen); } catch { return false; } };
  const round = {
    pubkey: b32(0xee), identity: { secret: b32(1) }, now: () => Date.now(),
    get: () => ({ contract: encodeRoundContract(c) }),
    signerNodes: () => keys,
    entriesOf: () => [{ entryId: e1, entry: { playerPubkey: player } }, { entryId: e2, entry: { playerPubkey: player } }],
    reruns: (r, e) => kept.filter((x) => hex(x.entryId) === hex(e)),
    provenFork: () => null,
    // round.js putRerun: a held record that counted stays; otherwise INSERT OR IGNORE
    putRerun: (r, e, who, bytes) => {
      const i = kept.findIndex((x) => hex(x.entryId) === hex(e) && hex(x.signerNodePubkey) === hex(who));
      const now = Date.now();
      if (i < 0) { kept.push({ entryId: e, signerNodePubkey: who, bytes, seenMs: now }); return 1; }
      if (!counted(kept[i].bytes, kept[i].seenMs) && counted(bytes, now)) { kept[i] = { entryId: e, signerNodePubkey: who, bytes, seenMs: now }; return 1; }
      return 0;
    },
  };
  const v = new Verifier(round, { peers: [`http://127.0.0.1:${evil.address().port}`, `http://127.0.0.1:${honest.address().port}`] });
  let got;
  try { got = await v.rerun(rid, e2, run2); } finally { evil.close(); honest.close(); }
  console.log('  FACTS:', JSON.stringify({ ok: got.ok, agreed: got.agreed, why: got.why, keptUnderE2: kept.filter((x) => hex(x.entryId) === hex(e2)).length }));
  assert.ok(got.ok && got.agreed >= 5,
    `six honest signers re-ran E2 and an honest peer served those re-runs, but this seat counts ${got.agreed}: seat 6's answer filled their E2 slots with their re-runs of E1`);
});
