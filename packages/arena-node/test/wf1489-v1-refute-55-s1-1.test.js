// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1-refute-55 (variant of #1548 through a real door): POST /first-mark, open to anyone who holds the entry's
// session key - the player. Each distinct on-time first mark (another state hash) sent with no batches is refused
// ("send the batches first", not FORFEIT), so the door calls round.putRefusedFirstMark, which writes an evidence_blocks
// row for every mark it is handed (refused_first_marks keeps one). #1548 bounded keepOffered's rows; this door is
// another way to the same unbounded per-entry growth at every seat.
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

test('wf1489-v1-refute-55-s1-1: POST /first-mark refusals do not grow evidence_blocks without bound', async () => {
  const w = await signerNodes({ endIn: 60000 });
  try {
    const run = await join(w);
    const { session } = run;
    const N = 400;
    const statuses = {};
    for (let i = 0; i < N; i++) {
      const m = { roundId: w.rid, entryId: run.eid, tick: 60, inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
        sessionPubkey: run.entry.sessionPubkey,
        stateHash: Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 0xff : 0x55)) };
      const bytes = joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
      const r = await fetch(`http://127.0.0.1:${w.a.port}/first-mark`, { method: 'POST', body: JSON.stringify({ mark: toHex(bytes), batches: [] }) });
      let why = ''; try { why = (await r.json()).why || ''; } catch { /* none */ }
      const k = `${r.status} ${why.slice(0, 60)}`; statuses[k] = (statuses[k] || 0) + 1;
    }
    const ev = w.a.round.db.prepare('SELECT COUNT(*) n FROM evidence_blocks WHERE entry_id = ?').get(run.eid).n;
    console.log('  FACTS:', JSON.stringify({ sent: N, statuses, evidenceRowsAtA: ev }));
    assert.ok(ev <= 256, `one player wrote ${ev} evidence_blocks rows for one entry at seat A through POST /first-mark - no bound`);
    // kanban #1738: the one refused first mark kept here is still evidence; the others write no row
    const kept = w.a.round.refusedFirstMark(run.eid);
    assert.ok(kept, 'the first refused first mark is kept');
    const keptId = checkpointId(decodeCheckpoint(splitSigned(kept.mark).body));
    const rows = w.a.round.evidenceBlocks(run.eid);
    assert.ok(rows.some((r) => toHex(r.markId) === toHex(keptId)), 'the kept refused first mark has its evidence record');
    assert.equal(rows.length, 1, `only the kept refused first mark is evidence (got ${rows.length} rows)`);
  } finally { await w.close(); }
});
