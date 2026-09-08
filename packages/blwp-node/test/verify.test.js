// A CLOSED ROUND REPLAYS ITSELF, AND NOTHING IN THIS FILE ASKS IT TO.
//
// The pool, the replay and the signing were all reachable only from tests,
// which is another way of saying the daemon did not do them. Section 13 has
// each committee node replay once the run is over, so closing the round is the
// event. Here the close goes over the socket, the way a real one does, and
// what is checked afterwards is what the node has WRITTEN DOWN - not anything
// this test handed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { init, step } from '../../core/src/sim.js';
import { hash } from '../../core/src/state.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../protocol/src/receipt.js';
import { splitSignedResult, decodePlayerResult, resultId, SIGNED_RESULT_BYTES } from '../../protocol/src/result.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const SEED = 7;                       // the fixture's own number, as ever
const TICKS = 600;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();          // the second committee seat

/** Two slots, so two receipts make a mark canonical - genesis.js's own rule. */
const contractFor = (nodePubkey) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2,
  settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, ed25519.getPublicKey(peer)],
});

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

function socket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const said = [];
  ws.on('message', (d, bin) => said.push(bin ? new Uint8Array(d) : d.toString()));
  const open = new Promise((r) => ws.once('open', r));
  return {
    ws, said, open,
    say: (m) => new Promise((r) => { const n = said.length; ws.send(m); const t = setInterval(() => {
      if (said.length > n) { clearInterval(t); r(said[n]); } }, 2); }),
  };
}

/** The player's own run, off the same core the client would be drawing from. */
function play(ticks) {
  const st = init(SEED);
  for (let t = 0; t < ticks; t++) step(st, ...wordsAt(t));
  return hash(st);
}

/**
 * A WHOLE ROUND THROUGH THE DAEMON'S OWN DOORS: contract, entry, inputs, a
 * mark, the second seat's receipt for it, and then "close".
 */
async function roundThrough(node, { objectFirst = false } = {}) {
  const c = contractFor(node.round ? node.round.pubkey : b32(0));
  const rid = roundId(c);
  assert.equal((await post(node.port, '/round', encodeRoundContract(c))).status, 201);

  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e),
  };
  const eid = entryId(entry);
  assert.equal((await post(node.port, '/entry', encodeEntryContract(entry))).status, 201);

  const s = socket(node.port);
  await s.open;

  const rows = [];
  for (let t = 0; t < TICKS; t++) rows.push(wordsAt(t));
  const batch = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [] };
  assert.equal(await s.say(encodeInputBatch(batch)), String(TICKS));

  // THE MARK, signed by the session key the entry names.
  const mark = {
    roundId: rid, entryId: eid, tick: TICKS, stateHash: hexToBytes(play(TICKS)),
    inputChainHash: batchId(batch), previousHash: NO_PREVIOUS,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const mid = checkpointId(mark);
  assert.equal(await s.say(joinSigned(encodeCheckpoint(mark), ed25519.sign(mid, session))), 'receipted');

  // AND THE SECOND SEAT'S RECEIPT, which is what makes it canonical (13C).
  const receipt = { checkpointId: mid, receivedAtMs: 1234n, nodePubkey: ed25519.getPublicKey(peer) };
  const rbody = encodeCheckpointReceipt(receipt);
  assert.equal(await s.say(joinSignedReceipt(rbody, ed25519.sign(receiptId(receipt), peer))), 'kept');

  if (objectFirst) {
    const r = await post(node.port, `/objection?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(r.status, 201);
  }

  assert.equal(await s.say(`close ${toHex(rid)}`), 'closed');
  s.ws.close();
  return { rid, eid, contract: c };
}

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

const results = async (port, rid, eid) => {
  const r = await fetch(`http://127.0.0.1:${port}/results?round=${toHex(rid)}&entry=${toHex(eid)}`);
  return { count: Number(r.headers.get('x-results')), bytes: new Uint8Array(await r.arrayBuffer()) };
};

/** Wait for the daemon's own work to finish, without doing any of it. */
const settle = async (node) => { for (const p of node.verifier.done) await p; };

/**
 * THE MEASUREMENT: a round closed over the socket leaves a signed result
 * behind, and this test never called `submit`.
 */
test('a round closed on a running daemon leaves a signed result nobody asked it for', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, seedFor: () => SEED });
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
    assert.equal(result.score, 230, 'the stored score is not the one the replay found');

    // THE SIGNATURE IS THE NODE'S OWN, over the id of what it stored.
    assert.ok(ed25519.verify(signature, resultId(result), node.round.pubkey),
      'the stored signature does not verify under the node that served it');
  } finally { await node.close(); }
});

/**
 * AND WITHOUT A SEED IT STOPS EXACTLY WHERE THE MISSING CLAUSE IS. The daemon
 * runs the whole path - close, queue, worker - and records the refusal rather
 * than inventing a world.
 */
test('a daemon with no seed replays nothing and says which clause is missing', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const { rid, eid } = await roundThrough(node);
    const answers = await Promise.all(node.verifier.done);

    assert.equal(answers.length, 1, 'the close queued no work at all');
    assert.equal(answers[0].stored, false);
    assert.match(answers[0].why, /`secret` is the player's/);
    assert.equal((await results(node.port, rid, eid)).count, 0);
  } finally { await node.close(); }
});

/**
 * THE OBJECTED QUEUE CAN BE NON-EMPTY ON A RUNNING DAEMON, which is what the
 * priority rule needed to be more than an arrangement between tests.
 */
test('an objection recorded over the wire reaches the pool as an objected job', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, seedFor: () => SEED });
  try {
    const { rid, eid } = await roundThrough(node, { objectFirst: true });
    assert.equal(node.round.objected(rid, eid), true, 'the node did not record the objection');
    await settle(node);
    assert.equal((await results(node.port, rid, eid)).count, 1);

    // a second objection against the same run is not a second objection
    const again = await post(node.port, `/objection?round=${toHex(rid)}&entry=${toHex(eid)}`);
    assert.equal(again.status, 200);
    assert.equal(await again.text(), 'already objected');

    // and one against a run this node has never heard of is refused
    const nowhere = await post(node.port, `/objection?round=${toHex(rid)}&entry=${toHex(b32(0x99))}`);
    assert.equal(nowhere.status, 404);
  } finally { await node.close(); }
});
