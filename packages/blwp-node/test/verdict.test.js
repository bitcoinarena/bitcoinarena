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
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replayInWorker } from '../src/replay.js';
import { resultFrom, signResult, verifiedFinal } from '../src/verdict.js';
import { resultId } from '../../protocol/src/result.js';
import { transcriptHash } from '../../protocol/src/transcript.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// The round's randomness beacon is a future Bitcoin block hash (5A) that this
// daemon does not read yet, so the fixture owns these 32 bytes. The seed is no
// longer a number anyone picks: it derives from this and the world secret
// the owner put on the Entry Contract.
const RANDOMNESS = b32(0x9b);
const session = ed25519.utils.randomSecretKey();
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

const secrets = [0, 1, 2, 3, 4, 5, 6].map(() => ed25519.utils.randomSecretKey());
const COMMITTEE = secrets.map((s) => ed25519.getPublicKey(s));
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
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
  const entry = {
    roundId: rid, playerPubkey: b32(player), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e),
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
      ed25519.sign(receiptId(receipt), secrets[i])));
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
  const s = stored(600);
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  assert.equal(answer.ok, true, answer.why);

  const signed = COMMITTEE.map((nodePubkey, i) => {
    const built = resultFrom({ answer, contract: s.contract, entry: s.entry,
      transcript: s.canonical, entryId: s.canonical.entryId, nodePubkey });
    assert.equal(built.ok, true, built.why);
    return { built: built.result, ...signResult(built.result, secrets[i]) };
  });

  // THE SCORE AND THE OUTCOME ARE READ OFF THE REPLAYED STATE, not defaulted.
  // 257 is what this run earns and FAILED is what it came to - a fixture that
  // only checked the two agreed with each other could not tell a real score
  // from a zero every node produced alike.
  //
  // It was 230 while the fixture chose the seed itself. The world is now the
  // one the entry's own secret and the round's randomness produce, so it is a
  // different world and a different score - measured, not adjusted to pass.
  assert.equal(answer.score, 257, 'the run no longer scores what this fixture was measured against');
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

  // FIVE OF SEVEN ON ONE RESULT. Every node signs its own result object
  // (its own key is a field), so agreement is on the run, not on the bytes:
  // rebuild each node's view of ONE node's result and sign that.
  const one = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, nodePubkey: COMMITTEE[0] }).result;
  const id = resultId(one);
  const over = (i) => ({ resultId: id, nodePubkey: COMMITTEE[i], signature: ed25519.sign(id, secrets[i]) });

  const five = verifiedFinal([0, 1, 2, 3, 4].map(over), { contract: s.contract });
  assert.equal(five.ok, true, five.why);
  assert.equal(five.needed, 5, 'the threshold did not come off the contract');
  assert.equal(five.verified, 5);
  assert.equal(five.final, true, five.why);

  // FOUR IS NOT FIVE.
  const four = verifiedFinal([0, 1, 2, 3].map(over), { contract: s.contract });
  assert.equal(four.final, false);
  assert.equal(four.verified, 4);

  // A SIGNATURE OVER A DIFFERENT RESULT IS NOT A SIGNATURE OVER THIS ONE.
  const otherId = resultId({ ...one, score: one.score + 1 });
  const lying = [over(0), over(1), over(2), over(3),
    { resultId: otherId, nodePubkey: COMMITTEE[4], signature: ed25519.sign(otherId, secrets[4]) }];
  const split = verifiedFinal(lying, { contract: s.contract });
  assert.equal(split.verified, 5, 'the fifth signature does verify - it is over another result');
  assert.equal(split.final, false, 'four on one result and one on another was called five');

  // A FORGERY IS DROPPED BEFORE THE COUNT, which is what this package can do
  // and the protocol package says it cannot.
  const forged = [over(0), over(1), over(2), over(3),
    { resultId: id, nodePubkey: COMMITTEE[4], signature: ed25519.sign(id, secrets[5]) }];
  const bad = verifiedFinal(forged, { contract: s.contract });
  assert.equal(bad.verified, 4);
  assert.equal(bad.forged, 1);
  assert.equal(bad.final, false, 'a signature from the wrong key was counted');

  // A NODE COUNTED TWICE IS NOT TWO NODES.
  const doubled = [over(0), over(1), over(2), over(3), over(3)];
  const twice = verifiedFinal(doubled, { contract: s.contract });
  assert.equal(twice.doubled, 1);
  assert.equal(twice.verified, 4);
  assert.equal(twice.final, false, 'one seat carried two votes');

  // and a stranger's perfectly good signature is not a seat
  const stranger = ed25519.utils.randomSecretKey();
  const outside = [over(0), over(1), over(2), over(3),
    { resultId: id, nodePubkey: ed25519.getPublicKey(stranger), signature: ed25519.sign(id, stranger) }];
  assert.equal(verifiedFinal(outside, { contract: s.contract }).final, false);
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
  const s = stored(600);
  const answer = await replayInWorker(s.transcript, s.entry, { roundRandomness: RANDOMNESS });
  const one = resultFrom({ answer, contract: s.contract, entry: s.entry,
    transcript: s.canonical, nodePubkey: COMMITTEE[0] }).result;
  const id = resultId(one);
  const over = (i) => ({ resultId: id, nodePubkey: COMMITTEE[i], signature: ed25519.sign(id, secrets[i]) });

  const two = { ...s.contract, gameVerifySlots: 2, nodes: COMMITTEE.slice(0, 2) };
  const both = verifiedFinal([over(0), over(1)], { contract: two });
  assert.equal(both.needed, 2, 'a two-slot round did not need two');
  assert.equal(both.final, true, both.why);
  assert.equal(verifiedFinal([over(0)], { contract: two }).final, false);

  const five = { ...s.contract, gameVerifySlots: 5 };
  assert.match(verifiedFinal([over(0)], { contract: five }).why, /no committee threshold for 5/);
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
  const mine = stored(600);
  const theirs = stored(600, { player: 6 });
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
