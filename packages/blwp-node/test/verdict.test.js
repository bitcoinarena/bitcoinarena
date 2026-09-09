// FIVE OF SEVEN SIGNING WHAT THEY EACH REPLAYED, AND A LATER NODE CAN CHECK IT
// WITHOUT REPLAYING ANYTHING.
//
// Section 13: each committee node replays the canonical transcript and signs a
// PlayerResult; five identical ones make it PROVISIONALLY_FINAL. The board of
// letter 20 already counts exactly these signatures - it says outright that it
// counts rather than verifies, because that package has no curve. This one
// does, so here a signature that does not verify never reaches the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumeSeated } from './seating.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replayInWorker } from '../src/replay.js';
import { resultFrom, signResult, verifiedFinal } from '../src/verdict.js';
import { resultId, joinSignedResult } from '../../protocol/src/result.js';
import { transcriptHash } from '../../protocol/src/transcript.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
// The round's randomness beacon is a future Bitcoin block hash (5A) that this
// daemon does not read yet, so the fixture owns these 32 bytes. The seed is no
// longer a number anyone picks: it derives from this and the world secret
// the owner put on the Entry Contract.
const RANDOMNESS = b32(0x9b);
const session = ed25519.utils.randomSecretKey();
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
// THE FIXTURE'S OWN WORLD, RE-MEASURED. Letter 36 gave the round its relief
// from its own seed, so this drive is on hills now and it DELIVERED where it
// used to wreck - and these tests are about a run that came to nothing. The
// world secret is the fixture's to choose and it chooses one where the drive
// still loses: b32(0x16) wrecks player 5 at tick 547 with a score of 128 and
// player 6 at 947. 1000 ticks is past both, and a run's state latches when it
// leaves LIVE.
const TICKS = 1000;

const secrets = [0, 1, 2, 3, 4, 5, 6].map(() => ed25519.utils.randomSecretKey());
const COMMITTEE = secrets.map((s) => schnorr.getPublicKey(s));
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: COMMITTEE,
});

/**
 * A STORED RUN WHOSE TRANSCRIPT IS CANONICAL BY 13C'S OWN GATE.
 *
 * The fixture used to hand-build the Transcript object, which meant the thing
 * being signed was not the thing the committee carries. Here the player's mark
 * is signed under the session key its entry names, a second seat receipts it,
 * and `Round#canonicalTranscript` is what produces the object - so the gate is
 * exercised rather than stepped around. Seven slots need five receipts, and
 * the node issues its own when it takes the mark, so four members supply the
 * rest - `receiptsNeeded`'s number, not one chosen here.
 */
function stored(ticks, { player = 5 } = {}) {
  const c = contract();
  const r = new Round(openStore(), () => 1234);
  const rid = r.open(c);
  assumeSeated(r, rid, c.nodes);
  const entry = {
    roundId: rid, playerPubkey: b32(player), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32),
  };
  const eid = r.enter(entry);
  const rows = [];
  for (let t = 0; t < ticks; t++) rows.push(wordsAt(t));
  const batch = {
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [],
  };
  assert.equal(r.batch(encodeInputBatch(batch)), ticks);

  // The player's own state at the last tick, off the same core, seeded the way
  // the entry's world secret and the round's randomness say.
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < ticks; t++) step(st, ...wordsAt(t));
  const stateHash = Uint8Array.from(hash(st).match(/../g).map((x) => parseInt(x, 16)));

  const mark = {
    roundId: rid, entryId: eid, tick: ticks, stateHash,
    inputChainHash: batchId(batch), previousHash: NO_PREVIOUS,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const mid = checkpointId(mark);
  r.checkpoint(joinSigned(encodeCheckpoint(mark), ed25519.sign(mid, session)));

  // AND THE SEATS THAT CARRY IT. Seven slots need five receipts; the node
  // issues its own when it takes the mark, so four committee members supply
  // the rest. Fewer would leave the transcript uncarried and canonical would
  // refuse - which is the gate, and it is not stepped around here.
  for (let i = 0; i < 4; i++) {
    const receipt = { checkpointId: mid, receivedAtMs: 1234n, nodePubkey: COMMITTEE[i] };
    r.takeReceipt(joinSignedReceipt(encodeCheckpointReceipt(receipt),
      schnorr.sign(receiptId(receipt), secrets[i])));
  }

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
  assert.equal(answer.score, 128, 'the run no longer scores what this fixture was measured against');
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
  assert.equal(ids.size, 7, 'the node key is not in the result id, so a seat cannot be told apart');
  for (const x of signed) assert.equal(x.built.score, signed[0].built.score);
  for (const x of signed) assert.equal(x.built.outcome, signed[0].built.outcome);

  // FIVE OF SEVEN ON ONE RUN.
  //
  // Each seat signs its OWN record - section 13's PlayerResult names its
  // signer - so their ids differ by construction and the agreement is on the
  // run they describe, not on bytes that could never match.
  const recordFor = (i) => {
    const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
      transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey: COMMITTEE[i] });
    return joinSignedResult(built.encoded, signResult(built.result, secrets[i]).signature);
  };
  const record = [0, 1, 2, 3, 4, 5, 6].map(recordFor);

  const five = verifiedFinal(record.slice(0, 5), { contract: s.contract, seats: s.contract.nodes });
  assert.equal(five.ok, true, five.why);
  assert.equal(five.needed, 5, 'the threshold did not come off the contract');
  assert.equal(five.final, true, five.why);
  assert.equal(five.agreed, 5);

  // FOUR IS NOT FIVE.
  const four = verifiedFinal(record.slice(0, 4), { contract: s.contract, seats: s.contract.nodes });
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
  const disagreed = verifiedFinal(split, { contract: s.contract, seats: s.contract.nodes });
  assert.equal(disagreed.final, false, 'four on one run and one on another was called five');
  assert.equal(disagreed.agreed, 4);

  // A SIGNATURE MADE WITH THE WRONG KEY IS NOT A SIGNATURE.
  const built5 = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey: COMMITTEE[4] });
  const forged = [...record.slice(0, 4),
    joinSignedResult(built5.encoded, signResult(built5.result, secrets[5]).signature)];
  const bad = verifiedFinal(forged, { contract: s.contract, seats: s.contract.nodes });
  assert.equal(bad.forged, 1);
  assert.equal(bad.final, false, 'a signature from the wrong key was counted');

  // ONE SEAT, ONE VOTE.
  const doubled = [...record.slice(0, 4), record[3]];
  const twice = verifiedFinal(doubled, { contract: s.contract, seats: s.contract.nodes });
  assert.equal(twice.doubled, 1);
  assert.equal(twice.final, false, 'one seat carried two votes');

  // AND A STRANGER'S PERFECTLY GOOD SIGNATURE IS NOT A SEAT.
  const strangerSecret = ed25519.utils.randomSecretKey();
  const strangerBuilt = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, entryId: s.canonical.entryId,
    nodePubkey: schnorr.getPublicKey(strangerSecret) });
  const outside = [...record.slice(0, 4),
    joinSignedResult(strangerBuilt.encoded, signResult(strangerBuilt.result, strangerSecret).signature)];
  const out = verifiedFinal(outside, { contract: s.contract, seats: s.contract.nodes });
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
  const both = verifiedFinal([recordFor(0), recordFor(1)], { contract: two, seats: two.nodes });
  assert.equal(both.needed, 2, 'a two-slot round did not need two');
  assert.equal(both.final, true, both.why);
  assert.equal(verifiedFinal([recordFor(0)], { contract: two, seats: two.nodes }).final, false);

  const five = { ...s.contract, gameVerifySlots: 5 };
  // SEATS SUPPLIED, so the refusal measured here is the THRESHOLD one and not
  // "that round has no seated committee": the two are different refusals and
  // this test is about the second.
  assert.match(verifiedFinal([recordFor(0)], { contract: five, seats: five.nodes }).why,
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
