// kanban #3028: the card's test (audit play r3-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit play r3 #1 (gap in the #2838 fix): receiptsKnownOf (server.js) reads each peer's GET /receipts of the entry with a cap
// of 64 receipts and, past the cap, drops that peer's WHOLE answer. GET /receipts serves every receipt of every mark of the
// run, so once a run has more than 64 receipts at a peer (a few dozen marks), no peer adds the first mark's receipts and the
// stranger's chosen NEEDED-1 receipts decide again: the seat that missed the first mark records ENTRY_VOID for a live run.
// Safe: a run whose first mark is carried by `needed` committee members is never ENTRY_VOID at any seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sevenSignerNodes, say, wait, toHex, NEEDED, SIGNED_RECEIPT_BYTES, ed25519, rand, secretScalar, dealHandout,
  feldmanGroup, FIELD, scalarFrom32, handoutId, entryId, encodeHandout, encodeEntryContract, lockFieldsToJson, refundKeyOf,
  netStakeMsat, entryFeeMsat, STAKE, LOSER, RANDOMNESS, GENESIS_HASH, wordsAt, seedWordForEntry, init, step, stateHash,
  batchId, encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS, sha256, b32, PAST } from './five-of-seven-fixture.js';
import { loaded, bedFrom } from './window-fixture.js';
import { signedBatchOf, splitSignedBatch } from '../../arena-protocol/src/batch.js';
import { splitSigned, decodeCheckpoint } from '../../arena-protocol/src/checkpoint.js';
import { splitSignedReceipt, decodeCheckpointReceipt } from '../../arena-protocol/src/receipt.js';

const EXTRA = 70;   // marks after the one past the start line, one tick each

async function joinLongRun(w) {
  const preimage = secretScalar();
  const e = rand(32);
  const session = ed25519.utils.randomSecretKey();
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: LOSER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: NEEDED, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: LOSER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: LOSER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint, claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const claimPk = w.signerNodes[0].dkg.signerNodeFor(w.c.nodes).pool.groupPublicKey;
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk, refundPk: refundKeyOf(LOSER.key), expiration: w.locks.height + 200 };
  await w.locks.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk, refundPk: refundKeyOf(LOSER.key), expiration: w.locks.height + 200 };
  await w.locks.put(feeOutpoint, feeFields);
  for (const d of w.signerNodes) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
    assert.equal((await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) })).status, 201);
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const sb = (b) => signedBatchOf(b, (id) => ed25519.sign(id, session));
  const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
  let t = 0;
  const hashTo = (tick) => { for (; t < tick; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, i) => wordsAt(i)), liquidations: [], loads: bedFrom(0) };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashTo(60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: PAST - 60 }, (_, i) => wordsAt(60 + i)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: PAST, stateHash: hashTo(PAST), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  const frames = [sb(b1), sign(m1), sb(b2), sign(m2)];
  let pb = b2, pm = m2;
  for (let k = 1; k <= EXTRA; k++) {
    const b = { roundId: w.rid, entryId: eid, previousHash: batchId(pb), firstTick: PAST + k - 1, ticks: [wordsAt(PAST + k - 1)], liquidations: [] };
    const m = { roundId: w.rid, entryId: eid, tick: PAST + k, stateHash: hashTo(PAST + k), inputChainHash: batchId(b), previousHash: checkpointId(pm), sessionPubkey: entry.sessionPubkey };
    frames.push(sb(b), sign(m));
    pb = b; pm = m;
  }
  return { eid, first: [sb(b1), sign(m1)], past: [sb(b2), sign(m2)], frames, firstId: checkpointId(m1) };
}

test('audit play r3 #1: past 64 receipts at each peer, the #2838 peer count adds none and a stranger voids a live run at a seat that missed the first mark', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 60000 });
  try {
    const run = await joinLongRun(w);
    await w.down(5, 6);
    for (const i of [0, 1, 2, 3, 4]) for (const f of run.frames) await say(w.signerNodes[i].port, f);
    for (let t = Date.now(); Date.now() - t < 8000 && w.signerNodes[0].round.receiptCount(run.firstId) < NEEDED; await wait(200));
    const carried = w.signerNodes[0].round.receiptCount(run.firstId);
    const r = await fetch(`http://127.0.0.1:${w.signerNodes[0].port}/receipts?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    const all = new Uint8Array(await r.arrayBuffer());
    const atPeer = all.length / SIGNED_RECEIPT_BYTES;
    const ofFirst = [];
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= all.length; at += SIGNED_RECEIPT_BYTES) {
      const one = all.slice(at, at + SIGNED_RECEIPT_BYTES);
      if (toHex(decodeCheckpointReceipt(splitSignedReceipt(one).body).checkpointId) === toHex(run.firstId)) ofFirst.push(one);
    }
    const voidsBefore = [0, 1, 2, 3, 4].map((i) => (w.signerNodes[i].round.entryVoid(run.eid) ? 1 : 0));
    await w.back(5);
    const posted = await fetch(`http://127.0.0.1:${w.signerNodes[5].port}/first-mark`, { method: 'POST', body: JSON.stringify({
      mark: toHex(run.first[1]), batches: [toHex(splitSignedBatch(run.first[0]).body)],
      entryVoid: { kind: 'mark', evidence: toHex(run.past[1]) }, receipts: ofFirst.slice(0, NEEDED - 1).map(toHex) }) });
    const said = { status: posted.status, body: await posted.text() };
    const facts = { carried, receiptsAtPeer0: atPeer, ofFirstPublic: ofFirst.length, voidsBefore, said, voidAt5: !!w.signerNodes[5].round.entryVoid(run.eid) };
    console.log('  FACTS audit-play-r3-1:', JSON.stringify(facts));
    assert.ok(carried >= NEEDED, `setup: the first mark is carried by ${carried} < ${NEEDED}`);
    assert.ok(atPeer > 64, `setup: peer 0 serves only ${atPeer} receipts`);
    assert.deepEqual(voidsBefore, [0, 0, 0, 0, 0], 'setup: a seat that took the live run voided it');
    assert.equal(facts.voidAt5, false, `seat 5 recorded ENTRY_VOID for a run ${carried} seats receipted (peers serve ${atPeer} receipts each, over the 64 cap), on ${NEEDED - 1} receipts a stranger chose: ${said.body}`);
  } finally { await w.close(); }
});

