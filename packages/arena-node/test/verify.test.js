// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CLOSED ROUND REPLAYS ITSELF, AND NOTHING IN THIS FILE ASKS IT TO.
//
// The pool, the replay and the signing were all reachable only from tests,
// which is another way of saying the daemon did not do them. Section 13 has
// each committee node replay once the run is over, so closing the round is the
// event. Here the close goes over the socket, the way a real one does, and
// what is checked afterwards is what the node has WRITTEN DOWN - not anything
// this test handed it.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { CLOCK } from './block-clock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumeAssigned, assumeStakeSeen } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash } from '../../nextblock/src/state.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt, SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import {
  splitSignedResult, decodePlayerResult, resultId, encodePlayerResult,
  joinSignedResult, SIGNED_RESULT_BYTES,
} from '../../arena-protocol/src/result.js';
import { verifiedFinal } from '../src/verdict.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { committeeSeedFromBeacon } from '../../arena-protocol/src/beacon.js';
import { selectCommittee } from '../../arena-protocol/src/sortition.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
// The round's randomness is a future Bitcoin block hash (5A) that this daemon
// does not read yet, so the fixture owns these 32 bytes the way it owns the
// keys. The SEED is no longer the fixture's: it derives from this and the
// entry's own world secret, which the owner put on the entry in e942580.
const RANDOMNESS = b32(0x9b);
// A beacon is a value AND a height: a hash on its own carries no date, and
// "published after the round" is the whole of what makes it worth using. The
// height is above the contract's census height, which is the ordering this
// contract can prove.
const HEIGHT = 900001;
const BEACON = { hash: RANDOMNESS, height: HEIGHT, timeMs: 900n };
// THE FIXTURE'S OWN WORLD, RE-MEASURED AGAIN (2026-09-16). These tests are about a run that
// came to nothing, and the world secret is the fixture's to choose. b32(0x16) chose one where the
// drive was WRECKED at tick 547 for a score of 128 - by armour that drove onto the truck. Armour
// now holds about 28 m off it, so nothing rams: measured, that same drive is still LIVE at tick
// 1000 with a score of 478, and 0 of 256 world secrets end both players inside 1000 ticks.
// What is left is the round's own clock - `outcome` returns MISSED at BLOCK_TICKS - so the earliest
// a drive can be lost without being rammed is tick 9000. Measured: 99 of 256 secrets lose both
// players, every one of them at 9000 and not one earlier. b32(0x21) is one of them, and it loses
// both with nothing to show: MISSED at 9000, score 0.
const TICKS = 9000;
// WHERE THE FIRST MARK GOES. A first mark after join_tick + the round's start deadline is FORFEIT
// (§15), and this fixture's rounds set that deadline to PLANTED_FIRST_MARK_DEADLINE. A run that ends
// on the round's own clock cannot have its first mark there, so it is planted early and the mark at
// the last tick chains onto it - which is what a real run does anyway, a mark a second.
const FIRST_MARK_TICK = 600;
// AND HOW MANY TICKS ONE BATCH CARRIES. A transcript length-prefixes each batch with a u16, so the
// round's 9000 ticks cannot go in one: 20 bytes a row plus 109 of header is 180,109. 1500 is 30,109.
const BATCH_TICKS = 1500;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();          // the second committee signer node

/** Two slots, so two receipts make a mark canonical - genesis.js's own rule. */
const contractFor = (nodePubkey) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2,
  settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

function socket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const said = [];
  ws.on('message', (d, bin) => said.push(bin ? new Uint8Array(d) : d.toString()));
  const open = new Promise((r) => ws.once('open', r));
  return {
    ws, said, open,
    say: (m) => new Promise((resolve, reject) => {
      const n = said.length;
      let waited = 0;
      ws.send(m);
      const t = setInterval(() => {
        if (said.length > n) { clearInterval(t); return resolve(said[n]); }
        // A DAEMON THAT NEVER ANSWERS MUST FAIL, NOT HANG. The first version
        // of this helper waited forever and took the whole node suite with
        // it when the socket path was wrong - a red test that never says so
        // is worse than a red test.
        if ((waited += 2) > 20000) { clearInterval(t); reject(new Error(`no answer to ${typeof m === 'string' ? m : 'a binary frame'} in 20s`)); }
      }, 2);
    }),
  };
}

/** The player's own run, off the same core the client would be drawing from. */
function play(ticks, entry) {
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < ticks; t++) step(st, ...wordsAt(t));
  return hash(st);
}

/**
 * A WHOLE ROUND THROUGH THE DAEMON'S OWN DOORS: contract, entry, inputs, a
 * mark, the second signer node's receipt for it, and then "close".
 */
async function roundThrough(node, {
  objectFirst = false, carried = true, contract, keepSocket = false,
  // WHICH SIGNER NODE CARRIES THE MARK. A receipt only counts from a key the round's
  // committee names, so a test with a different committee has to hand in the
  // signer node that belongs to it.
  signerNode = { secret: peer, pubkey: schnorr.getPublicKey(peer) },
} = {}) {
  const c = contract || contractFor(node.round ? node.round.pubkey : b32(0));
  const rid = roundId(c);
  assert.equal((await post(node.port, '/round', encodeRoundContract(c))).status, 201);
  // WHO THE CENSUS ASSIGNED, stated: this file is about replay, results and
  // thresholds, not about joining - which `roster.test.js` measures from real
  // blocks. Nothing in src/ assigns from a contract.
  assumeAssigned(node.round, rid, c.nodes);

  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x21), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  assert.equal((await post(node.port, '/entry', encodeEntryContract(entry))).status, 201);
  assumeStakeSeen(node.round, entry);

  const s = socket(node.port);
  await s.open;

  // THE INPUTS, IN BATCHES THE WIRE CAN CARRY. A transcript length-prefixes each batch with a u16,
  // so one batch of the round's 9000 ticks does not encode at all: 20 bytes a row plus 109 of header
  // is 180,109. BATCH_TICKS of 1500 is 30,109 bytes, and six of them chained - each naming the one
  // before, which `Round.batch` checks - carry the run. `batch` answers how many ticks were new.
  const batches = [];
  for (let from = 0; from < TICKS; from += BATCH_TICKS) {
    const rows = [];
    for (let t = from; t < from + BATCH_TICKS && t < TICKS; t++) rows.push(wordsAt(t));
    const b = { roundId: rid, entryId: eid, firstTick: from, ticks: rows, liquidations: [],
      previousHash: batches.length ? batchId(batches[batches.length - 1]) : GENESIS };
    assert.equal(await s.say(encodeInputBatch(b)), String(rows.length));
    batches.push(b);
  }
  const batch = batches[batches.length - 1];

  // THE FIRST MARK, planted inside the start deadline and signed by the session key the entry names.
  const planted = {
    roundId: rid, entryId: eid, tick: FIRST_MARK_TICK, stateHash: hexToBytes(play(FIRST_MARK_TICK, entry)),
    inputChainHash: batchId(batches[0]), previousHash: NO_PREVIOUS,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const pid = checkpointId(planted);
  const plantedReceipt = await s.say(joinSigned(encodeCheckpoint(planted), ed25519.sign(pid, session)));
  assert.equal(plantedReceipt.length, SIGNED_RECEIPT_BYTES,
    `the node refused the first mark: ${typeof plantedReceipt === 'string' ? plantedReceipt : plantedReceipt.length + ' bytes'}`);

  // AND THE MARK AT THE LAST TICK, chained onto it. The canonical transcript is the inputs the LAST
  // carried mark commits to, so this one is what makes the whole 9000-tick run canonical.
  const mark = {
    roundId: rid, entryId: eid, tick: TICKS, stateHash: hexToBytes(play(TICKS, entry)),
    inputChainHash: batchId(batch), previousHash: pid,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const mid = checkpointId(mark);
  // The node answers a mark with the RECEIPT it issued, not with a word.
  const receipted = await s.say(joinSigned(encodeCheckpoint(mark), ed25519.sign(mid, session)));
  assert.equal(receipted.length, SIGNED_RECEIPT_BYTES,
    `the node refused the mark: ${typeof receipted === 'string' ? receipted : receipted.length + ' bytes'}`);

  // AND THE SECOND SIGNER NODE'S RECEIPTS, which is what makes them canonical (13C). Both marks, or
  // the carried prefix stops at the first and the run replays to 600 ticks instead of the round.
  // Withheld when the caller wants to see what an uncarried transcript does.
  if (carried) {
    for (const cid of [pid, mid]) {
      const receipt = { checkpointId: cid, receivedAtMs: 1234n, nodePubkey: signerNode.pubkey };
      const rbody = encodeCheckpointReceipt(receipt);
      assert.equal(await s.say(joinSignedReceipt(rbody, schnorr.sign(receiptId(receipt), signerNode.secret))), 'held');
    }
  }

  if (objectFirst) {
    // AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13A): an empty body is 400; a real bundle before any
    // result is signed has nothing to object to (422) - neither is stored. The objected flag the close reads is then the
    // store's own record, as a run objected on an earlier close carries it.
    const at = `/objection?round=${toHex(rid)}&entry=${toHex(eid)}&block=${toHex(CLOCK.tipAt(Date.now()))}`;
    const empty = await post(node.port, at);
    assert.equal(empty.status, 400);
    assert.equal((await empty.text()).trim(), 'an objection carries its transcript and receipts (13A)');
    const { bundle } = await buildObjectionBundle({ base: `http://127.0.0.1:${node.port}`, roundId: rid, entryId: eid,
      signedRunId: b32(0x55), playerPubkey: entry.playerPubkey, claimed: { outcome: 'DELIVERED', score: 1 } });
    const early = await post(node.port, at, bundle);
    assert.equal(early.status, 422);
    assert.match(await early.text(), /there is no signed result for that entry to object to/);
    assert.equal(node.round.objected(rid, eid), false, 'a refused objection was stored');
    assert.equal(node.round.object(rid, eid), true);
  }

  assert.equal(await s.say(`close ${toHex(rid)}`), 'closed');
  if (!keepSocket) s.ws.close();
  // Both marks go back: the canonical prefix is carried marks IN ORDER, so a caller that carries
  // only the last one leaves a gap at the planted first and nothing is canonical at all.
  return { rid, eid, contract: c, socket: s, mark: { id: mid, planted: pid, signerNode } };
}

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

const results = async (port, rid, eid) => {
  const r = await fetch(`http://127.0.0.1:${port}/results?round=${toHex(rid)}&entry=${toHex(eid)}`);
  return { count: Number(r.headers.get('x-results')), bytes: new Uint8Array(await r.arrayBuffer()) };
};

/** Wait for the daemon's own work to finish, without doing any of it. */
const settle = async (node) => {
  for (const p of node.verifier.done) await p;
  await node.verifier.settling;               // and the asking the close set off
};

/**
 * THE MEASUREMENT: a round closed over the socket leaves a signed result
 * behind, and this test never called `submit`.
 */
test('a round closed on a running daemon leaves a signed result nobody asked it for', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    const { rid, eid, contract } = await roundThrough(node);
    await settle(node);

    const got = await results(node.port, rid, eid);
    assert.equal(got.count, 1, 'the daemon stored no result for a round it closed');
    assert.equal(got.bytes.length, SIGNED_RESULT_BYTES);

    const { body, signature } = splitSignedResult(got.bytes);
    const result = decodePlayerResult(body);
    assert.deepEqual(result.roundId, rid);
    assert.deepEqual(result.playerPubkey, b32(5));
    assert.deepEqual(result.nodePubkey, node.round.pubkey, 'the node signed under somebody else');
    assert.deepEqual(result.simCoreHash, contract.simCoreHash);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.score, 0, 'the stored score is not the one the replay found');

    // THE HASH IS THE CANONICAL TRANSCRIPT'S, 13C's own object - the prefix of
    // marks the committee receipted. A node that signed over the rows it
    // happened to hold would be signing a different object from its peers.
    assert.deepEqual(result.transcriptHash, node.round.canonicalTranscript(rid, eid).hash,
      'the signed hash is not the canonical transcript this node carries');

    // AND A SECOND REPLAY DOES NOT REWRITE WHAT THIS SIGNER NODE ALREADY SIGNED. One
    // signer node, one result: a node that could replace its own would be able to
    // change its answer after the committee had seen it.
    const before = got.bytes;
    for (const p of node.verifier.onRoundClosed(rid)) await p;
    const after = await results(node.port, rid, eid);
    assert.equal(after.count, 1, 'a second replay stored a second result for one signer node');
    assert.deepEqual(after.bytes, before, 'a second replay rewrote what the signer node had signed');

    // THE SIGNATURE IS THE NODE'S OWN, over the id of what it stored.
    assert.ok(schnorr.verify(signature, resultId(result), node.round.pubkey),
      'the stored signature does not verify under the node that served it');
  } finally { await node.close(); }
});

/**
 * AND WITHOUT A SEED IT STOPS EXACTLY WHERE THE MISSING CLAUSE IS. The daemon
 * runs the whole path - close, queue, worker - and records the refusal rather
 * than inventing a world.
 */
test('a daemon with no beacon, or one it could have known, signs nothing and says why', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const { rid, eid } = await roundThrough(node);
    const answers = await Promise.all(node.verifier.done);

    assert.equal(answers.length, 1, 'the close queued no work at all');
    assert.equal(answers[0].stored, false);
    assert.match(answers[0].why, /names no time, so nothing says it came after committee_time/);
    assert.equal((await results(node.port, rid, eid)).count, 0);
    assert.equal(node.verifier.queued[0].refused, answers[0].why,
      'the refusal was not recorded where the queue could be asked about it');
  } finally { await node.close(); }
});

/**
 * THE OBJECTED QUEUE CAN BE NON-EMPTY ON A RUNNING DAEMON, which is what the
 * priority rule needed to be more than an arrangement between tests.
 */
test('an objection recorded over the wire reaches the pool as an objected job', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    const { rid, eid } = await roundThrough(node, { objectFirst: true });
    assert.equal(node.round.objected(rid, eid), true, 'the node did not record the objection');

    // AND IT REACHED THE POOL AS AN OBJECTED JOB. Recording an objection the
    // queue never hears is the same as not recording one: the priority rule
    // proved in pool.test.js only means anything if the daemon sets the flag.
    assert.deepEqual(node.verifier.queued.map((q) => q.objected), [true],
      'the daemon queued the run without the objection it had just recorded');

    await settle(node);
    assert.equal((await results(node.port, rid, eid)).count, 1);

    // a second objection against the same run is not a second objection - and, the first on record, it costs no replay
    const { bundle } = await buildObjectionBundle({ base: `http://127.0.0.1:${node.port}`, roundId: rid, entryId: eid,
      signedRunId: b32(0x55), playerPubkey: b32(0x61), claimed: { outcome: 'DELIVERED', score: 1 } });
    const replays = node.verifier.objectionReplayCount;
    const again = await post(node.port, `/objection?round=${toHex(rid)}&entry=${toHex(eid)}&block=${toHex(CLOCK.tipAt(Date.now()))}`, bundle);
    assert.equal(again.status, 200);
    assert.equal((await again.text()).trim(), 'already objected');
    assert.equal(node.verifier.objectionReplayCount, replays, 'an entry that holds its objection replayed another bundle');

    // and one against a run this node has never heard of is refused
    const nowhere = await post(node.port, `/objection?round=${toHex(rid)}&entry=${toHex(b32(0x99))}&block=${toHex(CLOCK.tipAt(Date.now()))}`, bundle);
    assert.equal(nowhere.status, 404);
  } finally { await node.close(); }
});

/**
 * AND A TRANSCRIPT THE COMMITTEE HAS NOT CARRIED IS NOT SIGNED OVER.
 *
 * 13C makes the canonical transcript the prefix of marks enough members have
 * receipted. With one of two signer nodes holding the mark there is no canonical
 * transcript, and a node that signed anyway would be signing a different
 * object from the one its peers will sign - the disagreement would look like
 * a divergence in the run rather than in what was carried.
 */
test('a transcript no committee has carried is replayed and not signed', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    const { rid, eid } = await roundThrough(node, { carried: false });
    const answers = await Promise.all(node.verifier.done);

    assert.equal(answers.length, 1, 'the close queued no work');
    assert.equal(answers[0].stored, false, 'a result was signed over an uncarried transcript');
    assert.match(answers[0].why, /carried by 2 committee members|no checkpoints/);
    assert.equal((await results(node.port, rid, eid)).count, 0);
  } finally { await node.close(); }
});

/**
 * TWO SIGNER NODES, AND EACH ENDS UP HOLDING THE OTHER'S SIGNATURE.
 *
 * Serving a result nobody fetches is a committee of one writing in a diary.
 * Section 13 needs the threshold to have signed the IDENTICAL result, and that
 * is only checkable on a node holding more than its own signature. Two
 * daemons, two identities, one contract naming both - the same shape
 * `run-2of2` binds on Tailscale, over real sockets here.
 */
test('two daemons each fetch the other\'s result and a 2-of-2 counts to two', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    // ONE CONTRACT, naming both signer nodes. Neither node is the committee; the
    // contract is, and it names them by key.
    const c = {
      ...contractFor(a.round.pubkey),
      nodes: [a.round.pubkey, b.round.pubkey],
    };
    assert.notDeepEqual(a.round.pubkey, b.round.pubkey, 'two daemons share one identity');

    // Each is told where the other answers. A key is not an address: the
    // contract says whose signatures count, the operator says where they are.
    a.verifier.peers = [`http://127.0.0.1:${b.port}`];
    b.verifier.peers = [`http://127.0.0.1:${a.port}`];

    // Each daemon's mark is carried by the OTHER signer node, which is what the
    // contract names and what 13C's threshold counts.
    const signerNodeB = { secret: b.round.identity.secret, pubkey: b.round.pubkey };
    const signerNodeA = { secret: a.round.identity.secret, pubkey: a.round.pubkey };
    const first = await roundThrough(a, { contract: c, signerNode: signerNodeB });
    const second = await roundThrough(b, { contract: c, signerNode: signerNodeA });
    assert.equal(toHex(first.rid), toHex(second.rid), 'the two nodes are not in the same round');
    await settle(a); await settle(b);

    // THE DAEMON ALREADY ASKED. Closing a round replays it and then fetches
    // the other signer nodes, so the node that closed SECOND holds both signatures
    // with nothing in this test having called `gather`.
    const auto = await results(b.port, first.rid, first.eid);
    assert.equal(auto.count, 2,
      'the second daemon to close did not fetch the first one\'s result by itself');
    assert.equal(auto.bytes.length, 2 * SIGNED_RESULT_BYTES);

    // AND NOW THEY ASK. Two of two, counted against the contract's slots.
    const gotA = await a.verifier.gather(first.rid, first.eid);
    const gotB = await b.verifier.gather(first.rid, first.eid);

    assert.equal(gotA.ok, true, gotA.why);
    assert.equal(gotA.fetched >= 1, true, 'the peer served no result');
    assert.equal(gotA.held, 2, 'the node does not hold two results');
    assert.equal(gotA.needed, 2, 'the threshold did not come off the contract');
    assert.equal(gotA.verified, 2);
    assert.equal(gotA.final, true, gotA.why);
    assert.equal(gotB.final, true, gotB.why);

    // THE TWO RECORDS DESCRIBE ONE RUN AND NAME TWO SIGNERS.
    //
    // Their result IDS cannot match and must not be expected to: section 13's
    // PlayerResult carries `node_pubkey`, so a record names who made it. What
    // "the identical result" means is the identical RUN, and that is what the
    // two agree on - same player, same outcome, same score, same transcript,
    // same core - while the signer nodes differ.
    const held = a.round.results(first.rid, first.eid);
    assert.equal(held.length, 2);
    const [one, two] = held.map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
    assert.notDeepEqual(one.nodePubkey, two.nodePubkey, 'one signer node signed twice');
    assert.deepEqual(one.playerPubkey, two.playerPubkey);
    assert.equal(one.outcome, two.outcome);
    assert.equal(one.score, two.score);
    assert.deepEqual(one.transcriptHash, two.transcriptHash);
    assert.deepEqual(one.simCoreHash, two.simCoreHash);
    assert.notDeepEqual(held[0].resultId, held[1].resultId,
      'two records that name different signers produced one id');

    // and a signer the census did not assign does not count, however well it
    // signs: since letter 26 the Assigned set names the committee, not whoever
    // answers and not a list on the contract.
    const outsider = { ...c, nodes: [a.round.pubkey, b32(0xee)] };
    const short = verifiedFinal(held.map((r) => r.bytes),
      { contract: outsider, signerNodes: outsider.nodes });
    assert.equal(short.final, false, 'a stranger was counted as a signer node');
    assert.equal(short.strangers, 1);

    // ASKING AGAIN CHANGES NOTHING: one signer node, one result.
    const again = await a.verifier.gather(first.rid, first.eid);
    assert.equal(again.held, 2, 'a second fetch stored the peer\'s result twice');
    assert.equal(again.kept, 0, 'a record already held was written again');
    assert.equal(again.final, true);
  } finally { await a.close(); await b.close(); }
});

/**
 * A RECEIPT THAT ARRIVES LATE STILL MAKES A RESULT.
 *
 * 13C's canonical prefix grows as receipts come in, so a run replayed before
 * its transcript was carried is not a failure - it is an EARLY one. Without a
 * retry the node would have replayed it, found the answer, and thrown the
 * answer away: a late receipt would leave that run permanently unsigned.
 */
test('a receipt arriving after the close produces the result the replay could not sign', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    // Closed with the mark held by ONE of two signer nodes, so there is no canonical
    // transcript and nothing to sign over.
    const { rid, eid, socket, mark } = await roundThrough(node, { carried: false, keepSocket: true });
    await settle(node);
    assert.equal((await results(node.port, rid, eid)).count, 0,
      'a result was signed over a transcript nobody had carried');

    // NOW THE SECOND SIGNER NODE CARRIES IT, on the same socket a peer would use.
    // Both marks of the chain, because the prefix is carried in order: the planted first mark and
    // then the one at the last tick, which is what the canonical transcript commits to.
    let said;
    for (const cid of [mark.planted, mark.id]) {
      const receipt = { checkpointId: cid, receivedAtMs: 4321n, nodePubkey: mark.signerNode.pubkey };
      said = await socket.say(joinSignedReceipt(
        encodeCheckpointReceipt(receipt), schnorr.sign(receiptId(receipt), mark.signerNode.secret)));
      assert.equal(said, 'held');
    }

    await node.verifier.settling;
    for (const p of node.verifier.done) await p;

    const now = await results(node.port, rid, eid);
    assert.equal(now.count, 1, 'the late receipt did not produce a result');
    const result = decodePlayerResult(splitSignedResult(now.bytes).body);
    assert.deepEqual(result.transcriptHash, node.round.canonicalTranscript(rid, eid).hash);
    assert.equal(result.score, 0);

    // AND THE SIGNER NODE DOES NOT REPLAY AGAIN FOR A RUN IT HAS SIGNED. Asked
    // directly, the retry declines rather than queueing work whose answer the
    // store would only throw away.
    assert.equal(node.verifier.retry(rid, eid), null,
      'a signer node that has signed was queued to replay again');

    // AND A SECOND LATE RECEIPT DOES NOT SIGN IT AGAIN. One signer node, one result.
    const again = { checkpointId: mark.id, receivedAtMs: 4321n, nodePubkey: mark.signerNode.pubkey };
    await socket.say(joinSignedReceipt(
      encodeCheckpointReceipt(again), schnorr.sign(receiptId(again), mark.signerNode.secret)));
    await node.verifier.settling;
    assert.equal((await results(node.port, rid, eid)).count, 1);

    socket.ws.close();
  } finally { await node.close(); }
});

/**
 * WHAT COMES BACK FROM A PEER IS NOT BELIEVED BECAUSE IT CAME BACK.
 *
 * A fetched record is 232 bytes of somebody's claim. It is checked against the
 * signature under the key it names and against the run it is filed under; a
 * peer that could write into this node's tables by answering would be a peer
 * that decides what this node holds.
 */
test('a peer that serves forged or foreign records adds nothing to the store', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  let liar;
  try {
    const { rid, eid } = await roundThrough(node);
    await settle(node);
    assert.equal((await results(node.port, rid, eid)).count, 1);

    // The node's own record, re-signed with a key it does not belong to, and
    // a perfectly good record about a DIFFERENT round.
    const own = (await results(node.port, rid, eid)).bytes;
    const mine = decodePlayerResult(splitSignedResult(own).body);
    const stranger = ed25519.utils.randomSecretKey();
    const forged = joinSignedResult(
      splitSignedResult(own).body,
      schnorr.sign(resultId(mine), stranger));                 // wrong key, right bytes
    // The foreign one is otherwise IMPECCABLE: a real signer node of this round's
    // committee, signing correctly - about a different round. Only the check
    // that a record is about the run it is filed under can refuse it, so the
    // fixture would not notice that check missing if this were forged too.
    const elsewhere = { ...mine, roundId: b32(0x77), nodePubkey: schnorr.getPublicKey(peer) };
    const foreign = joinSignedResult(
      encodePlayerResult(elsewhere), schnorr.sign(resultId(elsewhere), peer));

    // AND ONE ABOUT ANOTHER PLAYER of this very round, signed impeccably by a
    // real signer node. A PlayerResult names no entry, so only the player check can
    // refuse it - and without that check this record would join's row
    // under this entry and keep the signer node's true answer out for good.
    const somebodyElse = { ...mine, playerPubkey: b32(0x42), nodePubkey: schnorr.getPublicKey(peer) };
    const wrongPlayer = joinSignedResult(
      encodePlayerResult(somebodyElse), schnorr.sign(resultId(somebodyElse), peer));

    const body = new Uint8Array(3 * SIGNED_RESULT_BYTES);
    body.set(forged, 0);
    body.set(foreign, SIGNED_RESULT_BYTES);
    body.set(wrongPlayer, 2 * SIGNED_RESULT_BYTES);

    liar = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(body));
    });
    await new Promise((r) => liar.listen(0, '127.0.0.1', r));
    node.verifier.peers = [`http://127.0.0.1:${liar.address().port}`];

    const got = await node.verifier.gather(rid, eid);
    assert.equal(got.fetched, 3, 'the peer served nothing to refuse');
    assert.equal(got.kept, 0, 'a forged or foreign record was written to the store');
    assert.equal(got.held, 1, 'the store grew from a peer that proved nothing');
    assert.equal(got.final, false, 'one signer node of two was called final');

    // AND A PEER THAT IS SIMPLY DOWN IS NOT A FAULT, only a peer that answered
    // nothing: a committee that stopped counting when a node was offline would
    // be a committee any one node could stall.
    node.verifier.peers = ['http://127.0.0.1:1'];
    const quiet = await node.verifier.gather(rid, eid);
    assert.equal(quiet.ok, true, quiet.why);
    assert.equal(quiet.refused, 1);
    assert.equal(quiet.held, 1);
  } finally {
    if (liar) await new Promise((r) => liar.close(r));
    await node.close();
  }
});

/**
 * A HASH THE ROUND'S CREATOR COULD HAVE HELD IS NOT A BEACON.
 *
 * 5A.5's whole point: in v4.4 the creator chose round_id while the randomness
 * was already known, so "grinding round_ids offline until both committees
 * consisted of his own nodes was trivial and undetectable". A node that signed
 * a result for such a round would be signing under a committee the creator
 * chose.
 */
test('a beacon at or before the round\'s committee time is refused before anything is replayed', async () => {
  // 5A.5 draws the line at `committee_time` now that the contract carries one:
  // "committee_time: beacon value appears -> committees selected & verified".
  // It used to be the census height, which was what the fields could prove.
  const early = { hash: RANDOMNESS, height: HEIGHT, timeMs: 500n };   // the committee time itself
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => early });
  try {
    const { rid, eid } = await roundThrough(node);
    const answers = await Promise.all(node.verifier.done);

    assert.equal(answers[0].stored, false);
    assert.match(answers[0].why,
      /from 500, at or before this round's committee time 500/);
    assert.match(answers[0].why, /could have held it when the round was made/);
    assert.equal((await results(node.port, rid, eid)).count, 0);

    // NOT REPLAYED AT ALL, not replayed and then discarded: a round whose
    // committee could have been ground is not worth a worker.
    assert.equal(node.verifier.queued[0].objected, false);
    assert.equal(node.verifier.queued[0].refused, answers[0].why);
    assert.equal(node.verifier.seeds.size, 0, 'a seed was kept for a round that was refused');

    // and a retry does not get round it either
    assert.equal(node.verifier.retry(rid, eid), null);
  } finally { await node.close(); }
});

/**
 * TWO DAEMONS, ONE PUBLISHED HASH AND HEIGHT, ONE COMMITTEE SEED.
 *
 * The seed is what 5A.5 selects signer nodes from, so two nodes that disagreed about
 * it would disagree about who the committee is - which is the one thing a
 * committee cannot survive.
 */
test('two daemons given the same published hash and height derive the same seed and signer nodes', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED, randomnessFor: () => BEACON });
  try {
    const c = { ...contractFor(a.round.pubkey), nodes: [a.round.pubkey, b.round.pubkey] };
    const signerNodeB = { secret: b.round.identity.secret, pubkey: b.round.pubkey };
    const signerNodeA = { secret: a.round.identity.secret, pubkey: a.round.pubkey };
    const { rid } = await roundThrough(a, { contract: c, signerNode: signerNodeB });
    await roundThrough(b, { contract: c, signerNode: signerNodeA });
    await settle(a); await settle(b);

    const seedA = a.verifier.seeds.get(toHex(rid));
    const seedB = b.verifier.seeds.get(toHex(rid));
    assert.ok(seedA, 'the daemon derived no committee seed');
    assert.deepEqual(seedA, seedB, 'two daemons on one beacon derived two seeds');

    // IT IS 5A.5'S OWN VALUE, not something this daemon made up.
    assert.deepEqual(seedA, committeeSeedFromBeacon(c,
      { roundId: rid, randomness: RANDOMNESS, height: HEIGHT, timeMs: BEACON.timeMs }).seed);

    // AND THE SAME SEED PICKS THE SAME SIGNER NODES.
    const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
      txid: b32(n), vout: 0, pubkey: b32(0xa0 + n), bondSats: 100000n,
      height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
    }));
    // THE SEED IS THE BEACON'S, handed to the lottery: the contract carries no
    // seed the selection reads, which is what makes grinding a round id
    // worthless rather than merely expensive.
    const signerNodesOf = (seed) => selectCommittee({
      entries, role: 'game', contract: c, committeeSeed: seed,
    }).map((e) => toHex(e.pubkey));
    assert.deepEqual(signerNodesOf(seedA), signerNodesOf(seedB));
    assert.equal(signerNodesOf(seedA).length, c.gameVerifySlots);

    // A DIFFERENT PUBLISHED HASH PICKS DIFFERENT SIGNER NODES, which is what makes
    // grinding the round id worthless.
    //
    // ASKED OF A SPREAD OF HASHES, NOT OF ONE. Two slots drawn from ten equal
    // bonds is ninety ordered pairs, so one other hash agrees with this one
    // about a percent of the time - and this file went red on exactly that,
    // with nothing wrong. What the claim needs is that the signer nodes MOVE with the
    // hash, so it is asked of sixteen of them: a selection that ignored the
    // beacon would return one set for all sixteen, and any real one returns
    // several. A single coincidence proves nothing either way and no longer
    // decides the test.
    const spread = new Set();
    for (let h = 0x9c; h < 0xac; h++) {
      const other = committeeSeedFromBeacon(c,
        { roundId: rid, randomness: b32(h), height: HEIGHT, timeMs: BEACON.timeMs }).seed;
      spread.add(signerNodesOf(other).join(','));
    }
    assert.ok(spread.size > 1,
      `sixteen published hashes picked the one committee ${[...spread][0]}, so the beacon does not reach the draw`);
    assert.ok([...spread].some((x) => x !== signerNodesOf(seedA).join(',')),
      'sixteen other hashes all picked this round\'s own committee');
  } finally { await a.close(); await b.close(); }
});
