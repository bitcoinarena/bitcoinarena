// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ENTRY_VOID (§16), THE OUTAGE REFUND, AT THE SIGNER NODES - AND THE LOCK BACK AT ONCE.
//
// "After commitment, before the first financial tick: if fewer than 5
// game/verify nodes are available, the entry becomes ENTRY_VOID and the stake
// is refunded by forfeit or by the stake lock's expiry (§23.2)." §23.2:
// "VOID / ENTRY_VOID: forfeit at once; if nobody acts, the lock expires."
//
// An ON-TIME first mark forwarded at once, and a signer node that did not answer: when
// the start deadline passes at the signer node holding it (the player's own mark past
// join + deadline), the first mark still short of 2 of 2 receipts, the entry is
// ENTRY_VOID there; a signer node that was down and comes back is shown the evidence
// and records the same Void, and the lock is forfeited to the player's refund
// key at once - both signer nodes sign, each on its own record. A signer node that comes back
// and is caught up by the player directly refuses the first mark too (§13C).
// Unchanged: a late first mark is FORFEIT. No mark at all is FORFEIT at the
// close (§15's walk-away, ruled 2026-09-12) - never ENTRY_VOID.
//
// MEASURED BEFORE (tools/outage-before.mjs, 3300558): (b) nothing recorded, no
// result, forfeit 409, a silent refund at expiry; (b') DELIVERED at both.
import { closeRound as closeRoundLive } from './lock-round-fixture.js';
import { testNow } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, playFor, warmPlay, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { presentDay } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { loaded, bedFrom } from './window-fixture.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;                      // 1320: past the 900 line; the run delivers here

async function signerNodes({ endIn = 9000 } = {}) {
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25), as lockRound in lock-round-fixture.js: both are
  // running daemons, so the claim key is their own live DKG; the round's beacon is that chain's, and the player seeds from it.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const mk = (db, p = 0) => serve(db, { plugins: HOSTED, port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 }, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor });
  const dbB = openStore(':memory:');
  const a = await mk(openStore(':memory:'));
  let b = await mk(dbB);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  // THIS ROUND NAMES NO START DEADLINE: the page's own window, 900.
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  // `endIn`: THE ROUND IN THE PRESENT, its end this many ms ahead - its result window open (WINDOW-10-SPEC). Left out, the
  // round ended in 1970 and its window closed long ago.
  const drafted = endIn === null ? base : presentDay(base, testNow() + endIn);
  const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
    { endpoints: [a, b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  const rid = roundId(c);
  const randomness = slot.randomnessFor({ contract: c }).hash;
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    a, get b() { return b; }, c, rid, port, randomness, claimPk: a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch { /* down */ } },
  };
}

async function joinAndBuild(w, { firstAt = 60, key = WINNER.key } = {}) {
  // THE WINNER UNDER THIS ROUND'S OWN BEACON (window-fixture playFor): the recorded tape misses there.
  await warmPlay(WINNER, w.randomness);
  const play = playFor(WINNER, w.randomness);
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  // AND IT BRINGS ITS FEE LOCK (2026-09-21). `lock-fixture`'s federation is legal now - no base fee, as §22A
  // requires - so this round's gate mints fee locks, and pick (a)'s door refuses an entry that names none.
  // That is the production shape: a staked entry arrives with the 2% already locked to H(F).
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk: w.claimPk, refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
  await w.port.put(feeOutpoint, feeFields);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
    assert.equal((await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) })).status, 201);
  }
  const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...play.words(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => play.words(from + t)), liquidations: [], loads: bedFrom(from) });
  const markOf = (tick, h, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: h, inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  let messages;
  let firstId;
  if (firstAt < END) {
    const b1 = batchOf(0, firstAt, GENESIS_HASH);
    const m1 = markOf(firstAt, hashAt(firstAt, 0), b1, NO_PREVIOUS);
    const b2 = batchOf(firstAt, END, batchId(b1));
    const m2 = markOf(END, hashAt(END, firstAt), b2, checkpointId(m1));
    messages = [signedBatchOf(b1, (id) => ed25519.sign(id, session)), sign(m1), signedBatchOf(b2, (id) => ed25519.sign(id, session)), sign(m2)];
    firstId = checkpointId(m1);
  } else {
    const b1 = batchOf(0, END, GENESIS_HASH);
    const m1 = markOf(END, hashAt(END, 0), b1, NO_PREVIOUS);
    messages = [signedBatchOf(b1, (id) => ed25519.sign(id, session)), sign(m1)];
    firstId = checkpointId(m1);
  }
  return { entry, eid, outpoint, messages, firstId, fields };
}

const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.replace(/^(error [A-Z_]+).*/, '$1').slice(0, 60)) : 'receipt');
async function forfeitAt(d, w, run) {
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  if (!f.ok) return { status: f.status, verifies: false };
  const j = await f.json();
  return { status: 200, verifies: schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1)),
    isTheLocksId: j.contractId === String(await w.port.contractId(run.fields)) };
}
function recordAt(d, w, run) {
  const v = d.round.entryVoid(run.eid);
  const late = d.round.startForfeit(run.eid);
  return { recorded: v ? `ENTRY_VOID (${v.evidenceKind})` : (late ? 'FORFEIT' : null),
    results: [...new Set(d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))],
    finality: resultFinality(d.round, w.rid, run.eid).state };
}
async function closeAndSettle(w, run) {
  // in live order past final_after (lock-round-fixture closeRound)
  await closeRoundLive({ a: w.a, b: w.b, rid: w.rid, c: w.c });
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
}
const until = async (fn, ms = 8000) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) if (fn()) return true; return false; };

// kanban #1489 r11 (play): ONE MARK, TWO BYTE STRINGS - THE PLAYER SPLITS THE COMMITTEE'S TRANSCRIPT HASH.
//
// decodeCheckpoint takes any version in SUPPORTED_PROTOCOL_VERSIONS, checkpointId re-encodes with PROTOCOL_VERSION, so
// a mark with its version byte changed is the same mark by id (same receipts, no equivocation - provesEquivocation says
// "the same mark, sent twice") but different BYTES - and canonicalTranscript puts the stored bytes into the transcript,
// whose hash every seat signs in its result. A modified client sends its last mark as version 1 to A and version 2 to B:
// each seat receipts it, both replay the same run, and sign two different transcript hashes - no run at the threshold.
// SAFE: the same mark is the same transcript at every seat; the run is FINAL DELIVERED as in test (a).
test('r11-play-2: a version-byte copy of a mark sent to one seat does not split the committee', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    const last = new Uint8Array(run.messages[3]);
    assert.equal(last[1], 0); assert.equal(last[2], 1);
    const lastV2 = new Uint8Array(last); lastV2[2] = 2;
    const said = { a: [], b: [] };
    for (const m of run.messages.slice(0, 3)) for (const [k, d] of [['a', w.a], ['b', w.b]]) said[k].push(answer(await say(d.port, m)));
    said.a.push(answer(await say(w.a.port, last)));
    said.b.push(answer(await say(w.b.port, lastV2)));
    await closeAndSettle(w, run);
    const hashes = (d) => [...new Set(d.round.results(w.rid, run.eid).map((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).transcriptHash)))];
    const facts = { said, a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), hashesAtA: hashes(w.a).length, hashesAtB: hashes(w.b).length };
    console.log('  FACTS (r11-play-2):', JSON.stringify(facts));
    assert.deepEqual(said, { a: ['60', 'receipt', '1260', 'receipt'], b: ['60', 'receipt', '1260', 'receipt'] });
    assert.deepEqual({ a: facts.a, b: facts.b }, { a: { recorded: null, results: ['DELIVERED'], finality: 'FINAL' },
      b: { recorded: null, results: ['DELIVERED'], finality: 'FINAL' } }, 'one mark in two encodings split the seats\' transcript hashes - no run at the threshold');
  } finally { await w.close(); }
});
