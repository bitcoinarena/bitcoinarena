// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1-refute-55 skeptic 2 (#1548 / #1738 sibling): #1738 made a refused on-time first mark write evidence only when it
// is the one refused_first_marks keeps. A LATE first mark takes the other branch: Round.putStartForfeit keeps one
// start_forfeits row per entry (INSERT OR IGNORE) but calls noteEvidenceBlock for every late first mark it is handed. The
// player resending distinct late first marks (POST /first-mark, a reconnecting /play socket) grows evidence_blocks at
// every seat without bound - the same door #1738 closed, one branch over.
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

test('wf1489-v1-refute-55-s2-2: late first marks do not grow evidence_blocks without bound', async () => {
  const w = await signerNodes({ endIn: 60000 });
  try {
    const run = await join(w);
    const { session } = run;
    const N = 400;
    const statuses = {};
    for (let i = 0; i < N; i++) {
      const m = { roundId: w.rid, entryId: run.eid, tick: 1000000 + i, inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
        sessionPubkey: run.entry.sessionPubkey,
        stateHash: Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 0xff : 0x66)) };
      const bytes = joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
      const r = await fetch(`http://127.0.0.1:${w.a.port}/first-mark`, { method: 'POST', body: JSON.stringify({ mark: toHex(bytes), batches: [] }) });
      let why = ''; try { why = (await r.json()).why || ''; } catch { /* none */ }
      const k = `${r.status} ${why.slice(0, 14)}`; statuses[k] = (statuses[k] || 0) + 1;
    }
    const ev = w.a.round.db.prepare('SELECT COUNT(*) n FROM evidence_blocks WHERE entry_id = ?').get(run.eid).n;
    const sf = w.a.round.db.prepare('SELECT COUNT(*) n FROM start_forfeits WHERE entry_id = ?').get(run.eid).n;
    console.log('  FACTS:', JSON.stringify({ sent: N, statuses, startForfeitRows: sf, evidenceRowsAtA: ev }));
    assert.ok(ev <= 256, `one player wrote ${ev} evidence_blocks rows for one entry at seat A with late first marks - no bound`);
  } finally { await w.close(); }
});
