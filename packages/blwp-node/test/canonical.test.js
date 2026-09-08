// THE CANONICAL TRANSCRIPT, SECTION 13C.
//
// "For each player, the canonical transcript is the longest checkpoint chain
// that carries receipts from at least 5 committee nodes, together with the
// input batches whose hashes it commits to. All nodes replay that object, so
// 'node A saw more than node B' cannot by itself produce disagreement."
//
// SELECTION, NOT SIMULATION. Nothing here replays anything and the node still
// imports no core - a daemon that recomputed the state would be a second
// simulator, and then two of them could disagree. What is measured is which
// marks the committee actually carried, and which inputs those marks commit to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { Round, RECEIPTS_FOR_CANONICAL } from '../src/round.js';
import { serve } from '../src/server.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import {
  GENESIS, decodeTranscript, checkTranscript, transcriptHash,
} from '../../protocol/src/transcript.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned, splitSigned,
} from '../../protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../protocol/src/receipt.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);

/** Seven committee keys; the node's own is added to the contract at open. */
const peers = Array.from({ length: 7 }, () => ed25519.utils.randomSecretKey());
const peerKeys = peers.map((k) => ed25519.getPublicKey(k));

const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: b32(0x43), simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});

const signedMark = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
const receiptFrom = (secret, id, ms) => {
  const r = { checkpointId: id, nodePubkey: ed25519.getPublicKey(secret), receivedAtMs: ms };
  return joinSignedReceipt(encodeCheckpointReceipt(r), ed25519.sign(receiptId(r), secret));
};

/**
 * A round with marks at 60 and 120, and a batch of 200 ticks under them.
 *
 * `carried` is how many DISTINCT committee members end up having receipted
 * each mark, counting the node's own: storing a checkpoint issues one, so the
 * floor is 1 and the peers make up the difference. Measured while writing
 * this - four peer receipts read as five members, because the node had already
 * signed one.
 */
function played(carried = []) {
  const round = new Round(openStore(), () => 1234);
  const c = contract([...peerKeys, round.identity.pubkey]);
  const rid = round.open(c);
  const e = entryFor(rid);
  const eid = round.enter(e);

  const words = Array.from({ length: 200 }, (_, i) => [i, 0, 0, 0, 0]);
  const batch = {
    roundId: rid, entryId: eid, firstTick: 0, previousHash: GENESIS,
    ticks: words, liquidations: [],
  };
  round.batch(encodeInputBatch(batch));
  const chain = batchId(batch);

  const ids = [];
  let previousHash = NO_PREVIOUS;
  for (const tick of [60, 120]) {
    const mark = {
      roundId: rid, entryId: eid, tick, stateHash: b32(tick),
      inputChainHash: chain, previousHash,
    };
    round.checkpoint(signedMark(mark));
    previousHash = checkpointId(mark);
    ids.push(previousHash);
  }

  ids.forEach((id, at) => {
    const many = Math.max((carried[at] || 1) - 1, 0);
    for (let i = 0; i < many; i++) round.takeReceipt(receiptFrom(peers[i], id, 1000n + BigInt(i)));
  });
  return { round, rid, eid, ids, chain, batch };
}

test('five is the number, and it is distinct members', () => {
  assert.equal(RECEIPTS_FOR_CANONICAL, 5);
});

test('four carried members is not a canonical chain', () => {
  const { round, rid, eid, ids } = played([4, 4]);
  assert.equal(round.receiptCount(ids[0]), 4);
  assert.throws(() => round.canonicalTranscript(rid, eid),
    /no checkpoint of that entry is carried by 5 committee members: the first has 4/);
});

test('five carried members is, and seven is the same chain', () => {
  for (const [many, name] of [[5, 'five'], [7, 'seven']]) {
    const { round, rid, eid, ids, batch } = played([many, many]);
    assert.equal(round.receiptCount(ids[0]), many, name);
    const c = round.canonicalTranscript(rid, eid);
    assert.equal(c.marks, 2);
    assert.equal(c.dropped, 0);
    assert.equal(c.throughTick, 120);
    assert.equal(c.ticks, 200);
    const t = decodeTranscript(c.bytes);
    assert.equal(t.batches.length, 1);
    assert.equal(toHex(batchId(t.batches[0])), toHex(batchId(batch)));
  }
});

/**
 * THE QUALIFYING PREFIX, NOT THE BROKEN TAIL. A mark five members carried is
 * canonical; the one after it that only one member saw is not, and handing the
 * whole thing over would be serving marks four members never saw.
 */
test('a chain that goes live and then falls short is served as its prefix', () => {
  const { round, rid, eid, ids } = played([5, 1]);
  assert.equal(round.receiptCount(ids[0]), 5);
  assert.equal(round.receiptCount(ids[1]), 1);

  const c = round.canonicalTranscript(rid, eid);
  assert.equal(c.marks, 1, 'the short mark was carried into the canonical chain');
  assert.equal(c.dropped, 1);
  assert.equal(c.throughTick, 60);

  // and the whole transcript is a different object with a different count
  assert.equal(round.checkpoints(rid, eid).count, 2);
});

/**
 * FIVE COPIES OF ONE SIGNER ARE ONE MEMBER. 13C counts committee NODES, and a
 * node that answered five times has said one thing five times.
 */
test('five receipts from one signer are not five members', () => {
  const { round, rid, eid, ids } = played();

  // the same receipt, five times: a repeat is a no-op, not a member
  const one = receiptFrom(peers[0], ids[0], 2000n);
  for (let i = 0; i < 5; i++) round.takeReceipt(one);
  // the node's own receipt and that one peer's, however often it spoke
  assert.equal(round.receiptCount(ids[0]), 2, 'one signer counted more than once');

  // and a DIFFERENT receipt from the same signer is not a second member
  // either - the node refuses it as a contradiction before counting arises
  assert.throws(() => round.takeReceipt(receiptFrom(peers[0], ids[0], 2001n)),
    /has already receipted .* differently/);
  assert.equal(round.receiptCount(ids[0]), 2);

  assert.throws(() => round.canonicalTranscript(rid, eid),
    /carried by 5 committee members: the first has 2/);
});

test('an entry with no checkpoints at all is refused by name', () => {
  const round = new Round(openStore(), () => 1234);
  const c = contract([...peerKeys, round.identity.pubkey]);
  const rid = round.open(c);
  const eid = round.enter(entryFor(rid));
  assert.throws(() => round.canonicalTranscript(rid, eid), /no checkpoints for that entry/);
});

test('the door serves it, and names its refusal', async () => {
  const { round, rid, eid } = played([5, 5]);
  const short = played([2, 1]);
  const node = await serve(round.db, { port: 0, funded: () => true });
  const other = await serve(short.round.db, { port: 0, funded: () => true });
  try {
    const at = (p, r, e) =>
      fetch(`http://127.0.0.1:${p}/canonical?round=${toHex(r)}&entry=${toHex(e)}`);

    const ok = await at(node.port, rid, eid);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-marks'), '2');
    assert.equal(ok.headers.get('x-dropped'), '0');
    assert.equal(ok.headers.get('x-through-tick'), '120');
    assert.equal(ok.headers.get('x-ticks'), '200');
    assert.equal(decodeTranscript(new Uint8Array(await ok.arrayBuffer())).batches.length, 1);

    const no = await at(other.port, short.rid, short.eid);
    assert.equal(no.status, 409);
    assert.match(await no.text(), /carried by 5 committee members: the first has 2/);
  } finally { await node.close(); await other.close(); }
});

/**
 * ONLY THE INPUTS THE CARRIED MARKS COMMIT TO. 13C says the canonical
 * transcript is the chain "together with the input batches whose hashes it
 * commits to" - not everything the node happens to hold. A player who kept
 * publishing after the committee stopped receipting has inputs on the node
 * that no carried mark ever committed to, and handing those over would make
 * the canonical object depend on what one node was sent.
 */
test('the inputs are the ones the carried marks commit to, not all of them', () => {
  const { round, rid, eid, chain, batch } = played([5, 5]);

  // a second batch, after both marks: nothing carried commits to it
  const later = {
    roundId: rid, entryId: eid, firstTick: 200, previousHash: chain,
    ticks: Array.from({ length: 100 }, (_, i) => [200 + i, 0, 0, 0, 0]),
    liquidations: [],
  };
  round.batch(encodeInputBatch(later));

  // the node holds both
  assert.equal(decodeTranscript(round.handOver(rid, eid).bytes).batches.length, 2);

  // and the canonical object holds one, the one the marks named
  const c = round.canonicalTranscript(rid, eid);
  const t = decodeTranscript(c.bytes);
  assert.equal(t.batches.length, 1, 'a batch no carried mark commits to was served');
  assert.equal(toHex(batchId(t.batches[0])), toHex(batchId(batch)));
  assert.equal(c.ticks, 200);
  assert.equal(c.marks, 2);
});

/**
 * AND THE MARKS ARE IN THE OBJECT, which is what 13C names FIRST.
 *
 * The canonical transcript is "the longest checkpoint chain ... TOGETHER WITH
 * the input batches whose hashes it commits to". For a while this served the
 * second half only, and the cost is measured below: two nodes that carried
 * different chains over the same batch handed back the same `transcriptHash`,
 * and a `PlayerResult` names nothing else. What the committee signs has to be
 * the object a replay is checked against, and what a replay is checked
 * against is the state the player signed at each mark.
 */
test('the canonical object carries the marks, and a stranger can check them', () => {
  const { round, rid, eid } = played([5, 5]);
  const c = round.canonicalTranscript(rid, eid);
  const t = decodeTranscript(c.bytes);

  assert.equal(t.marks.length, 2, 'the chain the committee carried travels with the inputs');
  assert.deepEqual(checkTranscript(t), { ok: true, ticks: 200, marks: 2, throughTick: 120 });
  assert.equal(toHex(transcriptHash(t)), toHex(c.hash), 'the hash is of what was served');

  // and the player really signed each of them: no node is asked and no
  // committee is needed, only the session key the entry already names.
  for (const m of t.marks) {
    const { body, signature } = splitSigned(m);
    assert.equal(ed25519.verify(signature, checkpointId(decodeCheckpoint(body)), sessionPubkey), true);
  }
});

test('two nodes that carried different chains no longer hand back one hash', () => {
  // One round, one entry, one batch of 200 ticks, and the same selection rule
  // applied at two moments: first when only the opening mark had five members
  // behind it, then when the second did too. That IS "node A saw more than
  // node B" - the difference is receipts and nothing else.
  const { round, rid, eid, ids } = played([5, 1]);

  const b = round.canonicalTranscript(rid, eid);
  assert.equal(b.marks, 1);

  for (let i = 0; i < 4; i++) round.takeReceipt(receiptFrom(peers[i], ids[1], 2000n + BigInt(i)));
  const a = round.canonicalTranscript(rid, eid);
  assert.equal(a.marks, 2);
  assert.notEqual(toHex(a.hash), toHex(b.hash), 'the served objects differ, so their hashes do');

  // and the inputs alone - all this used to hash - are byte-identical, which
  // is why the collision was there to find at all.
  const strip = (x) => ({ ...decodeTranscript(x.bytes), marks: [] });
  assert.equal(toHex(transcriptHash(strip(a))), toHex(transcriptHash(strip(b))));
});
