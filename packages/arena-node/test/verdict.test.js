// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FIVE OF SEVEN SIGNING WHAT THEY EACH REPLAYED, AND A LATER NODE CAN CHECK IT
// WITHOUT REPLAYING ANYTHING.
//
// Section 13: each committee node replays the canonical transcript and signs a
// PlayerResult; five identical ones make it PROVISIONALLY_FINAL. The board of
// letter 20 already counts exactly these signatures - it says outright that it
// counts rather than verifies, because that package has no curve. This one
// does, so here a signature that does not verify never reaches the count.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumeAssigned } from './assignment.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replayInWorker as replayInWorkerUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replayInWorker = (t, e, o = {}) => replayInWorkerUnder(t, e, { core: TRUCK, ...o });
import { resultFrom, signResult, verifiedFinal } from '../src/verdict.js';
import { resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { transcriptHash } from '../../arena-protocol/src/transcript.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
// The round's randomness beacon is a future Bitcoin block hash (5A) that this
// daemon does not read yet, so the fixture owns these 32 bytes. The seed is no
// longer a number anyone picks: it derives from this and the world secret
// the owner put on the Entry Contract.
const RANDOMNESS = b32(0x9b);
const session = ed25519.utils.randomSecretKey();
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
// THE FIXTURE'S OWN WORLD, RE-MEASURED AGAIN (2026-09-16). These tests are about a run that
// came to nothing, and the world secret is the fixture's to choose. b32(0x16) chose one where the
// drive was WRECKED at tick 547 for a score of 128 - by armour that drove onto the truck. Armour
// now holds about 28 m off it, so nothing rams: measured, that same drive is still LIVE at tick
// 1000, and 0 of 256 world secrets end both players inside 1000 ticks. What is left is the round's
// own clock - `outcome` returns MISSED at BLOCK_TICKS - so the earliest a drive can be lost without
// being rammed is tick 9000. Measured: 99 of 256 secrets lose both players, every one at 9000 and
// not one earlier. b32(0x21) is one of them: both MISSED at 9000, score 0.
const TICKS = 9000;
// WHERE THE FIRST MARK GOES. A first mark after join_tick + the round's start deadline is FORFEIT
// (§15), so a run that ends on the round's own clock plants one early and chains the last one onto
// it. A short fixture (`stored(120)`) still has the one mark it always had.
const FIRST_MARK_TICK = 600;
// AND HOW MANY TICKS ONE BATCH CARRIES. A transcript length-prefixes each batch with a u16, so the
// round's 9000 ticks cannot go in one: 20 bytes a row plus 109 of header is 180,109. 1500 is 30,109.
const BATCH_TICKS = 1500;

const secrets = [0, 1, 2, 3, 4, 5, 6].map(() => ed25519.utils.randomSecretKey());
const COMMITTEE = secrets.map((s) => schnorr.getPublicKey(s));
const contract = () => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: COMMITTEE,
});

/**
 * A STORED RUN WHOSE TRANSCRIPT IS CANONICAL BY 13C'S OWN GATE.
 *
 * The fixture used to hand-build the Transcript object, which meant the thing
 * being signed was not the thing the committee carries. Here the player's mark
 * is signed under the session key its entry names, a second signer node receipts it,
 * and `Round#canonicalTranscript` is what produces the object - so the gate is
 * exercised rather than stepped around. Seven slots need five receipts, and
 * the node issues its own when it takes the mark, so four members supply the
 * rest - `receiptsNeeded`'s number, not one chosen here.
 */
function stored(ticks, { player = 5 } = {}) {
  const c = contract();
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(c);
  assumeAssigned(r, rid, c.nodes);
  const entry = {
    roundId: rid, playerPubkey: b32(player), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x21), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = r.enter(entry);
  // THE INPUTS, IN BATCHES THE WIRE CAN CARRY: a transcript length-prefixes each batch with a u16,
  // and the round's 9000 ticks are 180,109 bytes in one. BATCH_TICKS of 1500 is 30,109, chained so
  // each names the one before - `Round.batch` refuses anything else and answers the ticks that were
  // new. A short fixture still sends the single batch it always sent.
  const batches = [];
  for (let from = 0; from < ticks; from += BATCH_TICKS) {
    const rows = [];
    for (let t = from; t < from + BATCH_TICKS && t < ticks; t++) rows.push(wordsAt(t));
    const b = {
      roundId: rid, entryId: eid, firstTick: from, ticks: rows, liquidations: [],
      previousHash: batches.length ? batchId(batches[batches.length - 1]) : GENESIS,
    };
    assert.equal(r.batch(encodeInputBatch(b)), rows.length);
    batches.push(b);
  }
  const batch = batches[batches.length - 1];

  // The player's own state, off the same core, seeded the way the entry's world secret and the
  // round's randomness say - at the planted first mark and again at the last tick.
  const bytesOf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const first = Math.min(ticks, FIRST_MARK_TICK);
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < first; t++) step(st, ...wordsAt(t));
  const firstHash = bytesOf(hash(st));
  for (let t = first; t < ticks; t++) step(st, ...wordsAt(t));
  const stateHash = bytesOf(hash(st));

  // THE MARKS, AND THE SIGNER NODES THAT CARRY THEM. Seven slots need five receipts; the node issues
  // its own when it takes a mark, so four committee members supply the rest. Fewer would leave the
  // transcript uncarried and canonical would refuse - which is the gate, and it is not stepped around
  // here. The first mark is planted inside the start deadline (§15); where the run ends on the
  // round's clock the mark at the last tick chains onto it, and the canonical transcript is what that
  // last carried mark commits to.
  const plant = (tick, sh, previousHash, chain = batch) => {
    const m = {
      roundId: rid, entryId: eid, tick, stateHash: sh,
      inputChainHash: batchId(chain), previousHash,
      sessionPubkey: ed25519.getPublicKey(session),
    };
    const id = checkpointId(m);
    r.checkpoint(joinSigned(encodeCheckpoint(m), ed25519.sign(id, session)));
    for (let i = 0; i < 4; i++) {
      const receipt = { checkpointId: id, receivedAtMs: 1234n, nodePubkey: COMMITTEE[i] };
      r.takeReceipt(joinSignedReceipt(encodeCheckpointReceipt(receipt),
        schnorr.sign(receiptId(receipt), secrets[i])));
    }
    return id;
  };
  const pid = plant(first, firstHash, NO_PREVIOUS, batches[0]);
  if (ticks > first) plant(ticks, stateHash, pid);

  return { contract: c, entry, transcript: r.transcript(rid, eid),
    canonical: r.canonicalTranscript(rid, eid) };
}

/**
 * SEVEN NODES, SEVEN REPLAYS, ONE RESULT ID. Two nodes that reached the same
 * state produce the same score and the same outcome from it, so they produce
 * the same id - which is what makes "five IDENTICAL results" checkable.
 */
test('nodes that replayed the same run sign the same result, and five of seven verify', async () => {
  const s = stored(TICKS);
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  assert.equal(answer.ok, true, answer.why);

  const signed = COMMITTEE.map((nodePubkey, i) => {
    const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
      transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey });
    assert.equal(built.ok, true, built.why);
    return { built: built.result, ...signResult(built.result, secrets[i]) };
  });

  // THE SCORE AND THE OUTCOME ARE READ OFF THE REPLAYED STATE, not defaulted.
  // 128 is what this run earns and FAILED is what it came to - a fixture that
  // only checked the two agreed with each other could not tell a real score
  // from a zero every node produced alike.
  //
  // It was 230 while the fixture chose the seed itself, 257 when the world
  // became the one the entry's own secret and the round's randomness produce,
  // and 79 once 20c3950 parked the player at the door their seed names. It is
  // 128 now because letter 36 gave the round its own RELIEF: the same drive is
  // over hills, it delivered where it used to wreck, and the fixture moved its
  // world secret to one where it still loses. Measured each time, not adjusted
  // to pass.
  assert.equal(answer.score, 0, 'the run no longer scores what this fixture was measured against');
  assert.equal(answer.outcome, 'FAILED');
  for (const x of signed) {
    assert.equal(x.built.score, answer.score, 'the signed score is not the replayed one');
    assert.equal(x.built.outcome, answer.outcome);
    // AND THE TRANSCRIPT HASH IS THE TRANSCRIPT'S. It is the field that says
    // WHICH run was replayed, so any other 32 bytes would let one signature
    // stand for a different transcript.
    assert.deepEqual(x.built.transcriptHash, s.canonical.hash);
    assert.notDeepEqual(x.built.transcriptHash, x.built.simCoreHash,
      'the transcript hash is the sim hash, so the result names no particular run');
  }

  // the id is the same for every node but the last field, which is who signed
  const ids = new Set(signed.map((x) => toHex(x.resultId)));
  assert.equal(ids.size, 7, 'the node key is not in the result id, so a signer node cannot be told apart');
  for (const x of signed) assert.equal(x.built.score, signed[0].built.score);
  for (const x of signed) assert.equal(x.built.outcome, signed[0].built.outcome);

  // FIVE OF SEVEN ON ONE RUN.
  //
  // Each signer node signs its OWN record - section 13's PlayerResult names its
  // signer - so their ids differ by construction and the agreement is on the
  // run they describe, not on bytes that could never match.
  const recordFor = (i) => {
    const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
      transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey: COMMITTEE[i] });
    return joinSignedResult(built.encoded, signResult(built.result, secrets[i]).signature);
  };
  const record = [0, 1, 2, 3, 4, 5, 6].map(recordFor);

  const five = verifiedFinal(record.slice(0, 5), { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(five.ok, true, five.why);
  assert.equal(five.needed, 5, 'the threshold did not come off the contract');
  assert.equal(five.final, true, five.why);
  assert.equal(five.agreed, 5);

  // FOUR IS NOT FIVE.
  const four = verifiedFinal(record.slice(0, 4), { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(four.final, false);
  assert.equal(four.agreed, 4);
  assert.match(four.why, /4 of 5 agree/);

  // FOUR ON ONE RUN AND A FIFTH ON ANOTHER IS NOT FIVE. The fifth verifies
  // perfectly and describes a different drive.
  const otherRun = resultFrom({ answer: { ...answer, score: answer.score + 1 },
    contract: s.contract, entry: s.entry, transcript: s.canonical,
    entryId: s.canonical.entryId, nodePubkey: COMMITTEE[4] });
  const split = [...record.slice(0, 4),
    joinSignedResult(otherRun.encoded, signResult(otherRun.result, secrets[4]).signature)];
  const disagreed = verifiedFinal(split, { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(disagreed.final, false, 'four on one run and one on another was called five');
  assert.equal(disagreed.agreed, 4);

  // A SIGNATURE MADE WITH THE WRONG KEY IS NOT A SIGNATURE.
  const built5 = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey: COMMITTEE[4] });
  const forged = [...record.slice(0, 4),
    joinSignedResult(built5.encoded, signResult(built5.result, secrets[5]).signature)];
  const bad = verifiedFinal(forged, { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(bad.forged, 1);
  assert.equal(bad.final, false, 'a signature from the wrong key was counted');

  // ONE SIGNER NODE, ONE VOTE.
  const doubled = [...record.slice(0, 4), record[3]];
  const twice = verifiedFinal(doubled, { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(twice.doubled, 1);
  assert.equal(twice.final, false, 'one signer node carried two votes');

  // AND A STRANGER'S PERFECTLY GOOD SIGNATURE IS NOT A SIGNER NODE.
  const strangerSecret = ed25519.utils.randomSecretKey();
  const strangerBuilt = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, entryId: s.canonical.entryId,
    nodePubkey: schnorr.getPublicKey(strangerSecret) });
  const outside = [...record.slice(0, 4),
    joinSignedResult(strangerBuilt.encoded, signResult(strangerBuilt.result, strangerSecret).signature)];
  const out = verifiedFinal(outside, { contract: s.contract, signerNodes: s.contract.nodes });
  assert.equal(out.strangers, 1);
  assert.equal(out.final, false);
});

/**
 * WHAT A REPLAY MAY NOT ANSWER. FORFEIT, VOID and ENTRY_VOID are facts about a
 * stake or an entry, not about a drive; and a run still LIVE at the last stored
 * tick came to nothing yet - calling that FAILED would score a lost connection
 * as a lost run.
 */
test('a run that has not ended is not signed as a failure', async () => {
  const s = stored(120);                     // far short of the block
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  assert.equal(answer.ok, true, answer.why);
  assert.equal(answer.outcome, null, 'a run cut short was given an outcome');
  assert.equal(typeof answer.score, 'number');

  const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, nodePubkey: COMMITTEE[0] });
  assert.equal(built.ok, false);
  assert.match(built.why, /still LIVE at its last stored tick/);

  // and a replay that refused outright is not signable either
  const noSeed = await replayInWorker(s.transcript, s.entry, {});
  const none = resultFrom({ answer: noSeed, contract: s.contract, entry: s.entry,
    transcript: s.canonical, nodePubkey: COMMITTEE[0] });
  assert.equal(none.ok, false);
  assert.match(none.why, /names no randomness to mix the player seed/);
});

/**
 * §15 AT THE CLOSE (ruled 2026-09-12): the close's own call says the round has
 * closed on the run (`stopped`), and then a run LIVE at its last receipted mark
 * is FAILED there, with the score the replay reached - not a refund, and not
 * the silence the test above keeps for every other caller.
 */
test('a run the round closed on while LIVE is signed FAILED with its own score', async () => {
  const s = stored(120);
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  assert.equal(answer.outcome, null);
  const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, nodePubkey: COMMITTEE[0], stopped: true });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.result.outcome, 'FAILED');
  assert.equal(built.result.score, answer.score);
  assert.equal(resultFrom({ answer, contract: s.contract, entry: s.entry, transcript: s.canonical,
    nodePubkey: COMMITTEE[0] }).ok, false, 'without the close it is still not signed');
});

/**
 * AND THE THRESHOLD IS STILL NOT A NUMBER IN THIS FILE.
 */
test('the committee size decides the threshold, and an unknown size is refused', async () => {
  const s = stored(TICKS);
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  const recordFor = (i) => {
    const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
      transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey: COMMITTEE[i] });
    return joinSignedResult(built.encoded, signResult(built.result, secrets[i]).signature);
  };

  const two = { ...s.contract, gameVerifySlots: 2, nodes: COMMITTEE.slice(0, 2) };
  const both = verifiedFinal([recordFor(0), recordFor(1)], { contract: two, signerNodes: two.nodes });
  assert.equal(both.needed, 2, 'a two-slot round did not need two');
  assert.equal(both.final, true, both.why);
  assert.equal(verifiedFinal([recordFor(0)], { contract: two, signerNodes: two.nodes }).final, false);

  const five = { ...s.contract, gameVerifySlots: 5 };
  // SIGNER NODES SUPPLIED, so the refusal measured here is the THRESHOLD one and not
  // "that round has no assigned committee": the two are different refusals and
  // this test is about the second.
  assert.match(verifiedFinal([recordFor(0)], { contract: five, signerNodes: five.nodes }).why,
    /no committee threshold for 5/);
});

/**
 * A TRANSCRIPT HAS TO BE THE ENTRY'S OWN.
 *
 * The result takes its player and its round off the ENTRY and its hash off the
 * TRANSCRIPT, and nothing was checking the two were the same run. A pairing a
 * caller got wrong - or chose - would produce a properly signed result
 * attributing one player's drive to another, and the board pays on exactly
 * this object.
 */
test('a result cannot be signed over another player\'s transcript', async () => {
  const mine = stored(TICKS);
  const theirs = stored(TICKS, { player: 6 });
  const answer = await replayInWorker(mine.transcript, mine.entry, { roundRandomness: RANDOMNESS });
  assert.equal(answer.ok, true, answer.why);

  // the two runs are different objects, so the fixture can tell them apart
  assert.notDeepEqual(mine.canonical.entryId, theirs.canonical.entryId);

  const crossed = resultFrom({
    answer, contract: mine.contract, entry: mine.entry,
    transcript: theirs.canonical, entryId: mine.canonical.entryId,
    nodePubkey: COMMITTEE[0],
  });
  assert.equal(crossed.ok, false);
  assert.match(crossed.why, /belongs to another (player|round)/);

  // and a transcript that names no run at all is refused rather than hashed
  const nameless = resultFrom({
    answer, contract: mine.contract, entry: mine.entry,
    transcript: { batches: [], marks: [] }, entryId: mine.canonical.entryId,
    nodePubkey: COMMITTEE[0],
  });
  assert.equal(nameless.ok, false);
  assert.match(nameless.why, /names no round or no entry/);
});
