// Checkpoints on one node: stored, repeated, and the one that must not be.
//
// The node never checks a state hash here and cannot: nothing in `src/`
// imports the core, which is what keeps the daemon a store rather than a
// second simulator. What it does check is the key - the same tick twice with
// different bytes is section 13B's equivocation, and it is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS,
  joinSigned, splitSigned, SIGNED_CHECKPOINT_BYTES, CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
// A REAL SESSION KEY, not a placeholder. The node verifies against the
// `sessionPubkey` on the entry contract, so a fixture with an invented key
// would only be able to prove the refusal, never the acceptance.
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});

/** What a client sends: the encoding, then the session key's signature over its id. */
const sign = (c, key = session) =>
  joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), key));

/**
 * A round with one entry, one batch of inputs, and a checkpoint maker chained
 * onto it.
 *
 * The batch is not decoration: a checkpoint names the inputs that claim to
 * have produced its state, and the node refuses a name it has never seen. So
 * the rig sends real inputs and the marks name the real batch, which is what
 * a client does.
 */
function rig() {
  const r = new Round(openStore(), () => 1234);
  const rid = r.open(contract());
  const eid = r.enter(entryFor(rid));

  const b = {
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 400 }, (_, i) => [65536, i, 0, 0, 0]),
    liquidations: [],
  };
  r.batch(encodeInputBatch(b));
  const inputs = batchId(b);

  let previous = NO_PREVIOUS;
  const make = (tick, state) => ({
    roundId: rid, entryId: eid, tick,
    stateHash: b32(state), inputChainHash: inputs, previousHash: previous,
  });
  // `send` advances the chain, so the mark it built is kept: asking `make`
  // for it again afterwards would build a DIFFERENT one, chained onto itself.
  let last = null;
  const send = (tick, state) => {
    const c = make(tick, state);
    last = c;
    const answer = r.checkpoint(sign(c));
    if (answer instanceof Uint8Array) previous = checkpointId(c);
    return answer;
  };
  return { r, rid, eid, inputs, make, send, last: () => last };
}

/**
 * WHAT AN ANSWER TO A CHECKPOINT NOW IS.
 *
 * It used to be the word 'stored' or 'repeat'. Those said whether the database
 * had changed, which is the node's business; what a player needs back is
 * evidence, and a receipt is evidence a third party can check without asking
 * this node anything. So every one of these assertions reads the receipt
 * rather than a word - and reads it the way a client would, by recomputing the
 * id and verifying the signature under the node's own key.
 */
function receiptOver(round, answer, c) {
  assert.ok(answer instanceof Uint8Array, `the answer is not bytes: ${answer}`);
  assert.equal(answer.length, SIGNED_RECEIPT_BYTES);
  const { body, signature } = splitSignedReceipt(answer);
  const r = decodeCheckpointReceipt(body);
  assert.deepEqual(r.checkpointId, checkpointId(c), 'the receipt answers a different mark');
  assert.deepEqual(r.nodePubkey, round.pubkey, 'the receipt is not this node\'s');
  assert.ok(ed25519.verify(signature, receiptId(r), round.pubkey),
    'the receipt does not verify under the key the node publishes');
  return r;
}

test('a checkpoint is receipted, and the same one again gets the SAME receipt', () => {
  const { r, make } = rig();
  const c = make(60, 0x5a);
  const first = r.checkpoint(sign(c));
  const firstReceipt = receiptOver(r, first, c);

  // Re-sending is what a client does when it never learned the first landed,
  // and it must not be given a second time for one commitment: section 10's
  // claim is that the player committed to that state at approximately that
  // real time, and two times would make that claim ambiguous.
  const again = r.checkpoint(sign(c));
  const againReceipt = receiptOver(r, again, c);
  assert.deepEqual(again, first, 'a repeat was answered with different bytes');
  assert.equal(againReceipt.receivedAtMs, firstReceipt.receivedAtMs,
    'a repeat was given a fresh timestamp');
});

test('two different checkpoints at one tick are refused by name', () => {
  const { r, make } = rig();
  const honest = make(60, 0x5a);
  const other = { ...make(60, 0x5b) };
  receiptOver(r, r.checkpoint(sign(honest)), honest);
  assert.throws(() => r.checkpoint(sign(other)), (e) => {
    assert.match(e.message, /equivocation at tick 60/);
    // Both ids are in the refusal, so the message IS the proof rather than a
    // report that one exists somewhere.
    assert.ok(e.message.includes(toHex(checkpointId(honest))), 'the stored id is named');
    assert.ok(e.message.includes(toHex(checkpointId(other))), 'the new id is named');
    return true;
  });
});

test('the chain is checked, so a checkpoint cannot be re-parented', () => {
  const { r, make, send, last } = rig();
  receiptOver(r, send(60, 0x5a), last());
  // tick 120 claiming to follow the genesis instead of the checkpoint at 60
  const orphan = { ...make(120, 0x5b), previousHash: NO_PREVIOUS };
  assert.throws(() => r.checkpoint(sign(orphan)),
    /does not follow the chain head/);
});

test('a checkpoint for an entry that is not here is refused', () => {
  const { r, make } = rig();
  const stranger = { ...make(60, 0x5a), entryId: b32(0x99) };
  assert.throws(() => r.checkpoint(sign(stranger)), /no such entry/);
});

test('a closed round takes no more checkpoints', () => {
  const { r, rid, make } = rig();
  r.close(rid);
  assert.throws(() => r.checkpoint(sign(make(60, 0x5a))), /the round is closed/);
});

test('they come back in tick order as fixed-size records', () => {
  const { r, rid, eid, send } = rig();
  for (let tick = 60; tick <= 300; tick += 60) send(tick, 0x40 + tick / 60);

  const got = r.checkpoints(rid, eid);
  assert.equal(got.count, 5);

  // No variable-length field anywhere, so the stream cuts itself apart into
  // fixed records of checkpoint plus signature.
  const size = got.bytes.length / got.count;
  assert.equal(size, SIGNED_CHECKPOINT_BYTES, 'every record is checkpoint plus signature');
  const ticks = [];
  for (let at = 0; at < got.bytes.length; at += size)
    ticks.push(decodeCheckpoint(splitSigned(got.bytes.slice(at, at + size)).body).tick);
  assert.deepEqual(ticks, [60, 120, 180, 240, 300]);
});

test('nothing in the node computed the state hash - it stored what it was given', () => {
  const { r, rid, eid, send } = rig();
  send(60, 0x5a);
  const back = decodeCheckpoint(splitSigned(r.checkpoints(rid, eid).bytes).body);
  assert.equal(toHex(back.stateHash), toHex(b32(0x5a)),
    'the hash that comes out is the one that went in, byte for byte');
});

test('a mark cannot run backwards through its own parent', () => {
  // Measured before the rule existed: tick 60 stored, then tick 30 naming the
  // tick-60 mark as its parent was ALSO stored, and the read handed back
  // [30, 60] - the chain claiming one order and the ticks another.
  const { r, rid, eid, make, send, last } = rig();
  receiptOver(r, send(60, 0x5a), last());
  const backwards = make(30, 0x5b);          // chains onto the mark at 60
  assert.throws(() => r.checkpoint(sign(backwards)),
    /expected a tick after 60, got 30/);
  assert.equal(r.checkpoints(rid, eid).count, 1, 'and nothing was stored');
});

test('the same tick twice is equivocation, not a backwards tick', () => {
  // The two refusals must not be confused: equal ticks are section 13B and
  // name both ids; a lower tick is the ordering rule.
  const { r, send, make } = rig();
  send(60, 0x5a);
  assert.throws(() => r.checkpoint(sign({ ...make(60, 0x5b), previousHash: NO_PREVIOUS })),
    /equivocation at tick 60/);
});

test('a mark naming inputs the node never saw is refused', () => {
  const { r, make } = rig();
  const invented = { ...make(60, 0x5a), inputChainHash: b32(0xee) };
  assert.throws(() => r.checkpoint(sign(invented)),
    /names inputs this node has not seen/);
});

test('a mark taken before any batch may name the genesis', () => {
  // A client that checkpoints at tick 0 has sent nothing yet, and refusing it
  // would make the first mark impossible.
  const r = new Round(openStore(), () => 1234);
  const rid = r.open(contract());
  const eid = r.enter(entryFor(rid));
  const c = {
    roundId: rid, entryId: eid, tick: 0,
    stateHash: b32(0x5a), inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  receiptOver(r, r.checkpoint(sign(c)), c);
});

/* -------------------------------------------------------------- signatures */

test('an unsigned mark has no shorter form, so it cannot be sent by accident', () => {
  const { r, make } = rig();
  assert.throws(() => r.checkpoint(encodeCheckpoint(make(60, 0x5a))),
    new RegExp(`a signed checkpoint is ${SIGNED_CHECKPOINT_BYTES} bytes, got ${CHECKPOINT_BYTES}`));
});

test('a mark signed by the wrong key is refused, and nothing is stored', () => {
  const { r, rid, eid, make } = rig();
  const stranger = ed25519.utils.randomSecretKey();
  assert.throws(() => r.checkpoint(sign(make(60, 0x5a), stranger)),
    /does not verify under the entry's session key/);
  assert.equal(r.checkpoints(rid, eid).count, 0);
});

test('changing any field after signing invalidates it', () => {
  const { r, make } = rig();
  for (const field of ['tick', 'stateHash', 'inputChainHash', 'previousHash']) {
    const c = make(60, 0x5a);
    const wire = sign(c);
    // re-encode a changed body under the same signature
    const changed = { ...c };
    if (field === 'tick') changed.tick = 61; else changed[field] = b32(0xab);
    const forged = joinSigned(encodeCheckpoint(changed), wire.slice(CHECKPOINT_BYTES));
    assert.throws(() => r.checkpoint(forged),
      /does not verify under the entry's session key/, field + ' was not covered');
  }
});

test('the signature is 64 bytes of noise away from valid', () => {
  const { r, make } = rig();
  const wire = sign(make(60, 0x5a));
  wire[SIGNED_CHECKPOINT_BYTES - 1] ^= 1;      // one bit of the signature
  assert.throws(() => r.checkpoint(wire), /does not verify under the entry's session key/);
});

test('signing does not change the id, so the chain is unmoved by it', () => {
  // This is why the signature sits beside the object: `previousHash` names the
  // same id whether or not the mark is signed.
  const { make } = rig();
  const c = make(60, 0x5a);
  const before = toHex(checkpointId(c));
  const wire = sign(c);
  assert.equal(toHex(checkpointId(decodeCheckpoint(splitSigned(wire).body))), before);
});

test('a signed mark is 231 bytes on the wire', () => {
  const { make } = rig();
  assert.equal(sign(make(60, 0x5a)).length, 231);
  assert.equal(CHECKPOINT_BYTES, 167);
});

/**
 * THE NODE IS THE SAME NODE AFTER A RESTART.
 *
 * A receipt is only worth something because it names the key that signed it
 * and that key can be checked against the round's committee. A daemon that
 * minted a fresh key on every start would invalidate every receipt it had
 * ever issued the moment it was restarted - and the player holding one would
 * have no way to tell that from a forgery.
 *
 * So it is read off the store, and this opens the same FILE twice to show it.
 * An in-memory store cannot show it: there is nothing to reopen.
 */
test('the node keeps its identity across a reopen of the same store', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'blwp-')), 'node.db');

  const first = new Round(openStore(path));
  const key = first.pubkey;
  assert.equal(key.length, 32);

  const again = new Round(openStore(path));
  assert.deepEqual(again.pubkey, key, 'the node came back as somebody else');

  // and a different store is a different node, or every daemon would be one
  const elsewhere = new Round(openStore(join(mkdtempSync(join(tmpdir(), 'blwp-')), 'node.db')));
  assert.notDeepEqual(elsewhere.pubkey, key, 'two separate nodes share one identity');
});
