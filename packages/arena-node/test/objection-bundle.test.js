// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13ARULED 2026-10-04). Measured on a 2-of-2
// round of two running signer nodes (lockRound: their own DKG, a real played run each for a winner and a loser):
//   (a) POST /objection with an empty body is 400 "an objection carries its transcript and receipts (13A)", nothing is
//       stored, and the run still becomes FINAL;
//   (b) an honest bundle - the canonical transcript and the receipts as the seats hand them out, claiming the result the
//       committee signed - is 422 "the replay agrees with the signed result", nothing stored;
//   (c) COLLUSION: both seats sign a forged result for the loser's run (its score one higher) while the true replay
//       differs, and each seat's own record agrees with the forgery. The player's bundle - the true transcript and the
//       seats' own receipts, claiming the true result - is upheld by a stranger running the checker on the round's
//       public record (tools/check-objection.mjs), and the seat that took it answers SUSPENDED;
//   (d) a bad signature, a receipt from outside the committee, a wrong transcript hash and a broken chain are each
//       refused by name, and nothing is stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, LOSER, wait } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { runId } from '../src/verdict.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { checkObjectionAt } from '../tools/check-objection.mjs';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { decodeObjectionBundle, encodeObjectionBundle, encodeObjection, objectionId } from '../../arena-protocol/src/objection.js';
import { decodeTranscript, encodeTranscript } from '../../arena-protocol/src/transcript.js';
import { decodeCheckpoint, splitSigned, checkpointId } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => decodePlayerResult(splitSignedResult(d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).bytes).body);
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);

/** A 2-of-2 round, a winner and a loser played, closed, both runs signed by both seats (PROVISIONALLY_FINAL at both). */
async function played() {
  const w = await lockRound({ endMs: testNow() + 4000 });
  const honest = await lockAndPlay(w, WINNER);
  const loser = await lockAndPlay(w, LOSER);
  await closeRound(w, { window: false });                   // inside the window: an objection is in time
  const both = await until(() => [w.a, w.b].every((d) => [honest, loser].every((p) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL')));
  assert.ok(both, `not both runs signed at both seats: ${JSON.stringify([w.a, w.b].map((d) => [honest, loser].map((p) => stateAt(d, w, p.eid).why)))}`);
  return { w, honest, loser };
}

/** BOTH SEATS SIGN A FORGED RESULT for `eid`: the true result's score + 1, each signed by the seat's own key and held by
 *  both - so the committee's run is the forgery, and each seat's own record agrees with it. Returns the true result. */
function forge(w, eid) {
  const truth = ownResult(w.a, w, eid);
  for (const d of [w.a, w.b]) d.round.db.prepare('DELETE FROM results WHERE round_id = ? AND entry_id = ?').run(w.rid, eid);
  for (const s of [w.a, w.b]) {
    const r = { ...truth, score: (truth.score + 1) >>> 0, nodePubkey: s.round.pubkey };
    const bytes = joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), s.round.identity.secret));
    for (const d of [w.a, w.b]) d.round.putResult(w.rid, eid, s.round.pubkey, resultId(r), bytes);
  }
  return truth;
}

/** The same bundle with its Objection changed and signed again by `secret` (the objector's own key, so step 1 passes). */
function resigned(b, secret, change) {
  const o = { ...b.objection, ...change };
  return encodeObjectionBundle({ objection: encodeObjection(o), signature: schnorr.sign(objectionId(o), secret), transcript: b.transcript, receipts: b.receipts });
}

test('(a) an empty body is 400 and nothing is stored, the run still becomes FINAL; (b) an honest bundle is 422 "the replay agrees with the signed result", nothing stored', async () => {
  const { w, honest } = await played();
  try {
    const empty = await postObjection(w.a, w, honest.eid, new Uint8Array(0));
    const emptyText = (await empty.text()).trim();
    const signed = ownResult(w.a, w, honest.eid);
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const before = w.a.verifier.objectionReplayCount;
    const fair = await postObjection(w.a, w, honest.eid, b.bundle);
    const fairText = (await fair.text()).trim();
    // THE DOOR'S BOUND (audit): the bundle, ten copies of it at once and another objector's bundle of the same run cost ONE replay
    const copies = await Promise.all(Array.from({ length: 10 }, () => postObjection(w.a, w, honest.eid, b.bundle).then(async (r) => [r.status, (await r.text()).trim()])));
    const other = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const otherAt = await postObjection(w.a, w, honest.eid, other.bundle);
    const replays = w.a.verifier.objectionReplayCount - before;
    const stranger = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: honest.eid, bundle: b.bundle });
    const stored = [w.a, w.b].map((d) => d.round.objected(w.rid, honest.eid));
    skipTo(Number(stateAt(w.a, w, honest.eid).finalAfterMs) + 50);
    const final = await until(() => [w.a, w.b].every((d) => stateAt(d, w, honest.eid).state === 'FINAL'), 20000);
    console.log('  FACTS (a, b):', JSON.stringify({ empty: [empty.status, emptyText], honest: [fair.status, fairText],
      signed: { outcome: signed.outcome, score: signed.score, run: toHex(runId(signed)).slice(0, 16) },
      stranger: { holds: stranger.holds, step: stranger.step, why: stranger.why, replayed: stranger.replayed, replayedRun: stranger.replayedRunId && stranger.replayedRunId.slice(0, 16) },
      stored, after: [w.a, w.b].map((d) => stateAt(d, w, honest.eid).state),
      bound: { copies: [...new Set(copies.map((c) => c.join(' ')))], other: otherAt.status, replaysForTwelve: replays } }));
    assert.equal(empty.status, 400);
    assert.equal(emptyText, 'an objection carries its transcript and receipts (13A)');
    assert.equal(fair.status, 422);
    assert.equal(fairText, 'the replay agrees with the signed result');
    assert.equal(stranger.holds, false);
    assert.equal(stranger.why, 'the replay agrees with the signed result');
    assert.equal(stranger.replayedRunId, toHex(runId(signed)), 'the stranger\'s replay is not the run the seats signed');
    assert.deepEqual(stored, [false, false], 'a refused objection was stored');
    assert.deepEqual(copies.map((c) => c[0]), Array(10).fill(422));
    assert.equal(otherAt.status, 422);
    assert.equal(replays, 1, `twelve bundles of one run cost ${replays} replays`);
    assert.ok(final, `the run did not become FINAL: ${[w.a, w.b].map((d) => stateAt(d, w, honest.eid).why).join(' | ')}`);
  } finally { await w.close(); }
});

test('(c) collusion: both seats sign a forged result; the player\'s bundle is upheld by a stranger, and the seat that takes it answers SUSPENDED; (d) a bad signature, an outside receipt, a wrong transcript hash and a broken chain are refused by name', async () => {
  const { w, loser } = await played();
  try {
    const eid = loser.eid;
    const truth = forge(w, eid);
    const forgedRun = stateAt(w.a, w, eid).runId;
    const ownAfter = toHex(runId(ownResult(w.a, w, eid)));
    assert.equal(stateAt(w.a, w, eid).state, 'PROVISIONALLY_FINAL', stateAt(w.a, w, eid).why);
    assert.equal(ownAfter, forgedRun, 'the seat\'s own record does not agree with the forgery: not the case the test names');
    assert.notEqual(forgedRun, toHex(runId(truth)));

    // THE PLAYER'S BUNDLE: the true transcript and the seats' own receipts, claiming the true result
    const secret = schnorr.utils.randomSecretKey();
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: eid, signedRunId: forgedRun,
      playerPubkey: truth.playerPubkey, claimed: { outcome: truth.outcome, score: truth.score }, objectorSecret: secret });

    // (d) FOUR FORGED BUNDLES, each refused by name at the seat's door, nothing stored
    const parts = decodeObjectionBundle(b.bundle);
    const badSig = encodeObjectionBundle({ objection: parts.objectionBytes, signature: Uint8Array.from(parts.signature, (v, i) => (i === 0 ? v ^ 1 : v)),
      transcript: parts.transcript, receipts: parts.receipts });
    const stranger = schnorr.utils.randomSecretKey();
    const firstMark = checkpointId(decodeCheckpoint(splitSigned(decodeTranscript(b.transcript).marks[0]).body));
    const outsideReceipt = { checkpointId: firstMark, receivedAtMs: 1n, nodePubkey: schnorr.getPublicKey(stranger) };
    const outside = encodeObjectionBundle({ objection: parts.objectionBytes, signature: parts.signature, transcript: parts.transcript,
      receipts: new Uint8Array([...parts.receipts, ...joinSignedReceipt(encodeCheckpointReceipt(outsideReceipt), schnorr.sign(receiptId(outsideReceipt), stranger))]) });
    const wrongHash = resigned(b, secret, { transcriptHash: new Uint8Array(32).fill(0x7e) });
    const t = decodeTranscript(b.transcript);
    const broken = { ...t, batches: t.batches.map((x, i) => (i === 0 ? { ...x, previousHash: new Uint8Array(32).fill(0x42) } : x)) };
    const brokenBundle = (await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: eid, signedRunId: forgedRun,
      playerPubkey: truth.playerPubkey, claimed: { outcome: truth.outcome, score: truth.score }, objectorSecret: secret,
      transcript: encodeTranscript(broken), receipts: b.receipts })).bundle;
    const refusals = {};
    for (const [name, body] of Object.entries({ badSignature: badSig, outsideReceipt: outside, wrongTranscriptHash: wrongHash, brokenChain: brokenBundle })) {
      const r = await postObjection(w.a, w, eid, body);
      refusals[name] = [r.status, (await r.text()).trim()];
    }
    const storedAfterForgeries = w.a.round.objected(w.rid, eid);

    // (c) THE STRANGER, on the round's public record from seat B, replaying here
    const check = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: eid, bundle: b.bundle });
    // AND SEAT A TAKES IT
    const took = await postObjection(w.a, w, eid, b.bundle);
    const tookText = (await took.text()).trim();
    const after = stateAt(w.a, w, eid);
    // AND ONCE HELD, ANOTHER BUNDLE COSTS NO REPLAY: "already objected" at the door
    const replaysBefore = w.a.verifier.objectionReplayCount;
    const again = await postObjection(w.a, w, eid, b.bundle);
    const againText = (await again.text()).trim();
    const replaysAgain = w.a.verifier.objectionReplayCount - replaysBefore;
    console.log('  FACTS (c):', JSON.stringify({ truth: { outcome: truth.outcome, score: truth.score, run: toHex(runId(truth)).slice(0, 16) },
      forgedRun: forgedRun.slice(0, 16), seatOwnRun: ownAfter.slice(0, 16),
      stranger: { holds: check.holds, why: check.why, replayed: check.replayed, replayedRun: check.replayedRunId && check.replayedRunId.slice(0, 16), signedRun: check.signedRunId && check.signedRunId.slice(0, 16) },
      seatA: [took.status, tookText], after: { state: after.state, objection: after.objection }, again: [again.status, againText, replaysAgain] }));
    console.log('  FACTS (d):', JSON.stringify({ refusals, storedAfterForgeries }));

    assert.equal(refusals.badSignature[0], 422);
    assert.match(refusals.badSignature[1], /^the objector's signature does not verify under /);
    assert.equal(refusals.outsideReceipt[0], 422);
    assert.match(refusals.outsideReceipt[1], new RegExp(`^the receipt from ${toHex(schnorr.getPublicKey(stranger)).slice(0, 16)} is not from this round's committee$`));
    assert.equal(refusals.wrongTranscriptHash[0], 422);
    assert.match(refusals.wrongTranscriptHash[1], /^the transcript carried hashes to [0-9a-f]{16}, and the objection names 7e7e7e7e7e7e7e7e$/);
    assert.equal(refusals.brokenChain[0], 422);
    assert.equal(refusals.brokenChain[1], 'the chain is broken at batch 0: the chain is broken here');
    assert.equal(storedAfterForgeries, false, 'a forged bundle was stored');

    assert.equal(check.holds, true, check.why);
    assert.equal(check.replayedRunId, toHex(runId(truth)), 'the stranger\'s replay is not the true run');
    assert.equal(check.signedRunId, forgedRun);
    assert.equal(took.status, 201, tookText);
    assert.equal(after.state, 'SUSPENDED', after.why);
    assert.deepEqual([again.status, againText, replaysAgain], [200, 'already objected', 0]);
  } finally { await w.close(); }
});
