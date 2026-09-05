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
} from '../../protocol/src/checkpoint.js';
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
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});

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
  const send = (tick, state) => {
    const c = make(tick, state);
    const answer = r.checkpoint(encodeCheckpoint(c));
    if (answer === 'stored') previous = checkpointId(c);
    return answer;
  };
  return { r, rid, eid, inputs, make, send };
}

test('a checkpoint is stored, and the same one again is a no-op', () => {
  const { r, make } = rig();
  const c = make(60, 0x5a);
  assert.equal(r.checkpoint(encodeCheckpoint(c)), 'stored');
  assert.equal(r.checkpoint(encodeCheckpoint(c)), 'repeat',
    're-sending is what a client does when it never learned the first landed');
});

test('two different checkpoints at one tick are refused by name', () => {
  const { r, make } = rig();
  const honest = make(60, 0x5a);
  const other = { ...make(60, 0x5b) };
  assert.equal(r.checkpoint(encodeCheckpoint(honest)), 'stored');
  assert.throws(() => r.checkpoint(encodeCheckpoint(other)), (e) => {
    assert.match(e.message, /equivocation at tick 60/);
    // Both ids are in the refusal, so the message IS the proof rather than a
    // report that one exists somewhere.
    assert.ok(e.message.includes(toHex(checkpointId(honest))), 'the stored id is named');
    assert.ok(e.message.includes(toHex(checkpointId(other))), 'the new id is named');
    return true;
  });
});

test('the chain is checked, so a checkpoint cannot be re-parented', () => {
  const { r, make, send } = rig();
  assert.equal(send(60, 0x5a), 'stored');
  // tick 120 claiming to follow the genesis instead of the checkpoint at 60
  const orphan = { ...make(120, 0x5b), previousHash: NO_PREVIOUS };
  assert.throws(() => r.checkpoint(encodeCheckpoint(orphan)),
    /does not follow the chain head/);
});

test('a checkpoint for an entry that is not here is refused', () => {
  const { r, make } = rig();
  const stranger = { ...make(60, 0x5a), entryId: b32(0x99) };
  assert.throws(() => r.checkpoint(encodeCheckpoint(stranger)), /no such entry/);
});

test('a closed round takes no more checkpoints', () => {
  const { r, rid, make } = rig();
  r.close(rid);
  assert.throws(() => r.checkpoint(encodeCheckpoint(make(60, 0x5a))), /the round is closed/);
});

test('they come back in tick order as fixed-size records', () => {
  const { r, rid, eid, send } = rig();
  for (let tick = 60; tick <= 300; tick += 60) send(tick, 0x40 + tick / 60);

  const got = r.checkpoints(rid, eid);
  assert.equal(got.count, 5);

  // No variable-length field, so the stream cuts itself apart.
  const size = got.bytes.length / got.count;
  assert.equal(size, Math.floor(size), 'every record is the same length');
  const ticks = [];
  for (let at = 0; at < got.bytes.length; at += size)
    ticks.push(decodeCheckpoint(got.bytes.slice(at, at + size)).tick);
  assert.deepEqual(ticks, [60, 120, 180, 240, 300]);
});

test('nothing in the node computed the state hash - it stored what it was given', () => {
  const { r, rid, eid, send } = rig();
  send(60, 0x5a);
  const back = decodeCheckpoint(r.checkpoints(rid, eid).bytes);
  assert.equal(toHex(back.stateHash), toHex(b32(0x5a)),
    'the hash that comes out is the one that went in, byte for byte');
});

test('a mark cannot run backwards through its own parent', () => {
  // Measured before the rule existed: tick 60 stored, then tick 30 naming the
  // tick-60 mark as its parent was ALSO stored, and the read handed back
  // [30, 60] - the chain claiming one order and the ticks another.
  const { r, rid, eid, make, send } = rig();
  assert.equal(send(60, 0x5a), 'stored');
  const backwards = make(30, 0x5b);          // chains onto the mark at 60
  assert.throws(() => r.checkpoint(encodeCheckpoint(backwards)),
    /expected a tick after 60, got 30/);
  assert.equal(r.checkpoints(rid, eid).count, 1, 'and nothing was stored');
});

test('the same tick twice is equivocation, not a backwards tick', () => {
  // The two refusals must not be confused: equal ticks are section 13B and
  // name both ids; a lower tick is the ordering rule.
  const { r, send, make } = rig();
  send(60, 0x5a);
  assert.throws(() => r.checkpoint(encodeCheckpoint({ ...make(60, 0x5b), previousHash: NO_PREVIOUS })),
    /equivocation at tick 60/);
});

test('a mark naming inputs the node never saw is refused', () => {
  const { r, make } = rig();
  const invented = { ...make(60, 0x5a), inputChainHash: b32(0xee) };
  assert.throws(() => r.checkpoint(encodeCheckpoint(invented)),
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
  assert.equal(r.checkpoint(encodeCheckpoint(c)), 'stored');
});
