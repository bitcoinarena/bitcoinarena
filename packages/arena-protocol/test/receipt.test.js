// The checkpoint receipt: a node's word that it held a mark at a time.
//
// Nothing issues one yet - a node signs with its own key and this daemon has
// none - so what is covered here is the object: that it round-trips, that its
// id moves when any field does, that it cannot be confused with a checkpoint,
// and that the wire lengths are what the node will be built against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  encodeCheckpointReceipt, decodeCheckpointReceipt, receiptId,
  splitSignedReceipt, joinSignedReceipt,
  RECEIPT_BYTES, RECEIPT_SIGNATURE_BYTES, SIGNED_RECEIPT_BYTES,
} from '../src/receipt.js';
import { encodeCheckpoint, NO_PREVIOUS, checkpointId } from '../src/checkpoint.js';
import { TYPE_CHECKPOINT_RECEIPT, TYPE_CHECKPOINT } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const mark = () => ({
  roundId: b32(7), entryId: b32(9), tick: 600,
  stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
});
const sample = () => ({
  checkpointId: checkpointId(mark()),
  receivedAtMs: 1788600000000n,
  nodePubkey: b32(0x2b),
});

test('a receipt survives the round trip byte for byte', () => {
  const r = sample();
  const bytes = encodeCheckpointReceipt(r);
  const back = decodeCheckpointReceipt(bytes);
  assert.equal(toHex(back.checkpointId), toHex(r.checkpointId));
  assert.equal(back.receivedAtMs, r.receivedAtMs);
  assert.equal(toHex(back.nodePubkey), toHex(r.nodePubkey));
  assert.equal(toHex(encodeCheckpointReceipt(back)), toHex(bytes));
});

test('the time is a u64 of milliseconds, not a number that loses digits', () => {
  const r = { ...sample(), receivedAtMs: 18446744073709551615n };
  assert.equal(decodeCheckpointReceipt(encodeCheckpointReceipt(r)).receivedAtMs,
    18446744073709551615n);
  assert.throws(() => encodeCheckpointReceipt({ ...sample(), receivedAtMs: 1788600000000 }),
    /u64 needs a BigInt/);
});

test('two nodes receipting the same mark give different receipts', () => {
  // The signer is part of it, so five receipts for one checkpoint are five
  // objects and not one repeated.
  const one = sample();
  const other = { ...sample(), nodePubkey: b32(0x2c) };
  assert.notEqual(toHex(receiptId(one)), toHex(receiptId(other)));
});

test('the time is part of it, so a receipt cannot be re-dated', () => {
  const one = sample();
  const later = { ...sample(), receivedAtMs: sample().receivedAtMs + 1n };
  assert.notEqual(toHex(receiptId(one)), toHex(receiptId(later)));
});

test('the mark is part of it, so a receipt cannot be moved to another mark', () => {
  const other = { ...sample(), checkpointId: checkpointId({ ...mark(), tick: 660 }) };
  assert.notEqual(toHex(receiptId(sample())), toHex(receiptId(other)));
});

test('a checkpoint is not a receipt, and the reader says so by type', () => {
  const bytes = encodeCheckpointReceipt(sample());
  bytes[0] = TYPE_CHECKPOINT;
  assert.throws(() => decodeCheckpointReceipt(bytes),
    new RegExp(`not a checkpoint receipt: type ${TYPE_CHECKPOINT}`));
});

test('and a receipt is not a checkpoint either - the types do not collide', () => {
  assert.notEqual(TYPE_CHECKPOINT_RECEIPT, TYPE_CHECKPOINT);
  assert.equal(encodeCheckpointReceipt(sample())[0], TYPE_CHECKPOINT_RECEIPT);
  assert.equal(encodeCheckpoint(mark())[0], TYPE_CHECKPOINT);
});

test('trailing bytes are refused rather than ignored', () => {
  const bytes = encodeCheckpointReceipt(sample());
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => decodeCheckpointReceipt(longer), /trailing bytes/);
});

test('the encoder agrees with the length the wire is built on', () => {
  assert.equal(encodeCheckpointReceipt(sample()).length, RECEIPT_BYTES);
  assert.equal(RECEIPT_BYTES, 75);
  assert.equal(SIGNED_RECEIPT_BYTES, 139);
});

test('the signature sits beside it, so signing does not move the id', () => {
  const r = sample();
  const before = toHex(receiptId(r));
  const wire = joinSignedReceipt(encodeCheckpointReceipt(r),
    new Uint8Array(RECEIPT_SIGNATURE_BYTES).fill(9));
  assert.equal(toHex(receiptId(decodeCheckpointReceipt(splitSignedReceipt(wire).body))), before);
});

test('a record of the wrong length is refused rather than mis-cut', () => {
  const body = encodeCheckpointReceipt(sample());
  assert.throws(() => splitSignedReceipt(body), /a signed receipt is 139 bytes, got 75/);
  assert.throws(() => joinSignedReceipt(body, new Uint8Array(10)),
    /a signature is 64 bytes, got 10/);
});

test('the halves come back exactly as they went in', () => {
  const sig = new Uint8Array(RECEIPT_SIGNATURE_BYTES).map((_, i) => i);
  const wire = joinSignedReceipt(encodeCheckpointReceipt(sample()), sig);
  const { body, signature } = splitSignedReceipt(wire);
  assert.equal(toHex(body), toHex(encodeCheckpointReceipt(sample())));
  assert.equal(toHex(signature), toHex(sig));
});
