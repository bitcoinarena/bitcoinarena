// The checkpoint, and the one property it exists for: two of them at the same
// tick that are not the same object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS,
} from '../src/checkpoint.js';
import { TYPE_CHECKPOINT, TYPE_INPUT_BATCH } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  roundId: b32(7), entryId: b32(9), tick: 600,
  stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
});

test('a checkpoint survives the round trip byte for byte', () => {
  const c = sample();
  const bytes = encodeCheckpoint(c);
  const back = decodeCheckpoint(bytes);
  assert.equal(back.tick, c.tick);
  assert.equal(toHex(back.stateHash), toHex(c.stateHash));
  assert.equal(toHex(back.inputChainHash), toHex(c.inputChainHash));
  assert.equal(toHex(back.previousHash), toHex(c.previousHash));
  assert.equal(toHex(encodeCheckpoint(back)), toHex(bytes));
});

test('the wire size is fixed, whatever the round is doing', () => {
  const quiet = encodeCheckpoint(sample());
  const busy = encodeCheckpoint({ ...sample(), tick: 4294967295, stateHash: b32(0xff) });
  assert.equal(quiet.length, busy.length,
    'a checkpoint carries no variable-length field, so a node can budget for it');
});

test('a state hash that differs gives a different checkpoint at the same tick', () => {
  // This is section 13B in one line: the two objects are addressable at the
  // same (round, entry, tick) and they are not equal, which is what makes a
  // player's equivocation a portable proof rather than an argument.
  const one = sample();
  const other = { ...sample(), stateHash: b32(0x5b) };
  assert.notEqual(toHex(checkpointId(one)), toHex(checkpointId(other)));
});

test('the same checkpoint always hashes the same, so a repeat is a repeat', () => {
  assert.equal(toHex(checkpointId(sample())), toHex(checkpointId(sample())));
});

test('the inputs are part of it, not beside it', () => {
  // A checkpoint that named a state but not the inputs claiming to have
  // produced it could be lifted from one transcript onto another.
  const one = sample();
  const other = { ...sample(), inputChainHash: b32(0x1d) };
  assert.notEqual(toHex(checkpointId(one)), toHex(checkpointId(other)));
});

test('a batch is not a checkpoint, and the reader says so by type', () => {
  const bytes = encodeCheckpoint(sample());
  bytes[0] = TYPE_INPUT_BATCH;
  assert.throws(() => decodeCheckpoint(bytes), /not a checkpoint: type 8/);
});

test('the type byte is the protocol\'s own', () => {
  assert.equal(encodeCheckpoint(sample())[0], TYPE_CHECKPOINT);
});

test('trailing bytes are refused rather than ignored', () => {
  const bytes = encodeCheckpoint(sample());
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => decodeCheckpoint(longer), /trailing bytes/);
});
