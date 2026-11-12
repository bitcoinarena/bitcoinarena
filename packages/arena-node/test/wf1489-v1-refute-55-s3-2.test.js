// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1-refute-55 skeptic 3 (#1548 / #1738 / #1883 / #1914, a second copy of the same growth): 4ca2c45a7 bounded what a
// peer's /evidence-blocks answer adds, per peer. But the close's pair pull (#equivocationProven, the same pull at every close
// retry, pullFirstMarkProof, pullEvidence at the re-run window) reads a peer's GET /evidence-blocks sibling, GET /equivocation,
// with no cap at all (r.arrayBuffer(), no size bound), and keeps every valid "two chains from one parent" pair it finds -
// laterParent pairs do not end the loop - as a fork_pairs row plus TWO evidence_blocks rows via putForkPair ->
// noteEvidenceBlock, as this seat's OWN records (pulled_from NULL: outside the per-peer bound, and served on to every
// other seat). One committee seat that also plays (or holds a player's session key) signs as many such pairs as it likes:
// every honest seat's fork_pairs and evidence_blocks for that entry grow without bound, and equivocation()/provenFork read
// them all back on every close.
import { test } from 'node:test';
import { signerNodes, assert, ed25519, toHex, encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS, WINNER, rand, b32, sha256,
  secretScalar, dealHandout, feldmanGroup, scalarFrom32, FIELD, STAKE, entryFeeMsat, handoutId, entryId, netStakeMsat, refundKeyOf,
  encodeHandout, encodeEntryContract, lockFieldsToJson } from './first-mark-fixture.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { decodeCheckpoint, splitSigned } from '../../arena-protocol/src/checkpoint.js';

// the fixture's joinAndBuild, up to the join (its session key is not handed out): joined, stake and fee lock at both seats
async function join(w) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint, claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk: w.claimPk, refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(feeOutpoint, feeFields);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
    assert.equal((await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) })).status, 201);
  }
  return { entry, eid, session };
}

import http from 'node:http';
import { Verifier } from '../src/verify.js';

test('wf1489-v1-refute-55-s3-2: one peer\'s /equivocation answer does not grow evidence_blocks or fork_pairs without bound', async () => {
  const w = await signerNodes({ endIn: 60000 });
  let srv;
  try {
    const run = await join(w);
    const { session } = run;
    let k = 0;
    const mark = (tick, parent) => {
      const m = { roundId: w.rid, entryId: run.eid, tick, inputChainHash: GENESIS, previousHash: parent,
        sessionPubkey: run.entry.sessionPubkey, stateHash: Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (k >> (8 * j)) & 0xff : 0x77)) };
      k++;
      return joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    };
    const PAIRS = 300;
    let served = 0;
    srv = http.createServer((req, res) => {
      if (req.url.startsWith('/equivocation')) {
        const parts = [];
        for (let i = 0; i < PAIRS; i++) { const p = rand(32); parts.push(mark(100 + i, p), mark(200 + i, p)); }
        served += PAIRS;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.concat(parts.map((x) => Buffer.from(x))));
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const peer = `http://127.0.0.1:${srv.address().port}`;
    const v = new Verifier(w.a.round, { peers: [peer], pool: {} });
    for (let i = 0; i < 3; i++) { try { await v.pullFirstMarkProof(w.rid, run.eid); } catch { /* the rest of the pull */ } }
    const ev = w.a.round.db.prepare('SELECT COUNT(*) n FROM evidence_blocks WHERE entry_id = ?').get(run.eid).n;
    const own = w.a.round.db.prepare('SELECT COUNT(*) n FROM evidence_blocks WHERE entry_id = ? AND pulled_from IS NULL').get(run.eid).n;
    const fp = w.a.round.db.prepare('SELECT COUNT(*) n FROM fork_pairs WHERE entry_id = ?').get(run.eid).n;
    console.log('  FACTS:', JSON.stringify({ pairsServed: served, forkPairsAtA: fp, evidenceRowsAtA: ev, ofThemOwn: own }));
    assert.ok(ev <= 256 && fp <= 256, `one peer's /equivocation answers wrote ${fp} fork_pairs and ${ev} evidence_blocks rows (${own} as A's own) for one entry - no bound`);
  } finally { if (srv) srv.close(); await w.close(); }
});
