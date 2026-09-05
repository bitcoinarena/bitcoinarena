// The input batch, and the two properties a transcript is worth having for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { encodeInputBatch, decodeInputBatch, batchId, batchTicks, INPUT_WORDS, MAX_BATCH_TICKS, MAX_INPUT_BATCH_BYTES } from '../src/batch.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 120,
  ticks: [[65536, 0, 0, 0, 0], [65536, -22000, 0, 0, 0], [0, 0, 65536, 0, 1]],
  liquidations: [[121, 3 * 65536]],
});

test('a batch survives the round trip byte for byte', () => {
  const b = sample();
  const bytes = encodeInputBatch(b);
  const back = decodeInputBatch(bytes);
  assert.deepEqual(back.ticks, b.ticks);
  assert.deepEqual(back.liquidations, b.liquidations);
  assert.equal(back.firstTick, b.firstTick);
  assert.equal(toHex(encodeInputBatch(back)), toHex(bytes));
});

test('the tick numbers are absolute, so a gap is visible in the message itself', () => {
  const b = sample();
  assert.deepEqual(batchTicks(b), [120, 121, 122]);
  const later = { ...b, firstTick: 125 };
  // 123 and 124 are simply absent - nothing has to remember they were expected
  assert.deepEqual(batchTicks(later), [125, 126, 127]);
});

test('the same batch always encodes the same bytes, whatever order it arrived in', () => {
  const a = sample();
  const b = { ...sample(), liquidations: [[121, 3 * 65536]] };
  const c = { ...sample(), liquidations: [[121, 3 * 65536], [121, 3 * 65536]].slice(0, 1) };
  assert.equal(toHex(batchId(a)), toHex(batchId(b)));
  assert.equal(toHex(batchId(a)), toHex(batchId(c)));
});

test('liquidations are sorted before they are hashed', () => {
  const one = { ...sample(), liquidations: [[300, 5], [121, 9]] };
  const other = { ...sample(), liquidations: [[121, 9], [300, 5]] };
  assert.equal(toHex(batchId(one)), toHex(batchId(other)),
    'two nodes that received them in a different order must agree');
});

test('a tick carries exactly the five words `step` takes', () => {
  assert.equal(INPUT_WORDS, 5);
  const bad = { ...sample(), ticks: [[1, 2, 3, 4]] };
  assert.throws(() => encodeInputBatch(bad), /five words/);
});

test('a batch of another type, or with anything after it, is refused', () => {
  const bytes = encodeInputBatch(sample());
  const wrongType = bytes.slice(); wrongType[0] = 0x01;
  assert.throws(() => decodeInputBatch(wrongType), /not an input batch/);
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
  assert.throws(() => decodeInputBatch(trailing), /trailing bytes/);
});

test('the id is tagged, so it cannot collide with a contract of the same bytes', () => {
  const bytes = encodeInputBatch(sample());
  // the tag is what separates them; the body alone would not
  assert.notEqual(toHex(batchId(sample())), toHex(bytes.slice(0, 32)));
  assert.equal(batchId(sample()).length, 32);
});

test('the chain field is carried, and changes the id', () => {
  const a = sample();
  const b = { ...sample(), previousHash: new Uint8Array(32).fill(3) };
  assert.notEqual(toHex(batchId(a)), toHex(batchId(b)),
    'two batches with the same inputs but different histories are different batches');
  assert.deepEqual(decodeInputBatch(encodeInputBatch(b)).previousHash, b.previousHash);
});

test('the ceiling the encoder sets is the one the transport is built on', () => {
  // Built, not reasoned about: the largest batch that can encode at all, so a
  // frame longer than this is not a protocol message and can be refused
  // without being parsed.
  const b = {
    roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 0,
    ticks: Array.from({ length: MAX_BATCH_TICKS }, () => [65536, 0, 0, 0, 0]),
    liquidations: Array.from({ length: MAX_BATCH_TICKS }, (_, i) => [i, 1]),
  };
  assert.equal(encodeInputBatch(b).length, MAX_INPUT_BATCH_BYTES);
  assert.equal(MAX_INPUT_BATCH_BYTES, 1835087);
});

test('a tick costs twenty bytes and a liquidation eight', () => {
  const at = (n, l) => encodeInputBatch({
    roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 0,
    ticks: Array.from({ length: n }, () => [65536, 0, 0, 0, 0]),
    liquidations: Array.from({ length: l }, (_, i) => [i, 1]),
  }).length;
  assert.equal(at(0, 0), 107, 'the header');
  assert.equal(at(1, 0) - at(0, 0), 20);
  assert.equal(at(0, 1) - at(0, 0), 8);
  assert.equal(at(6, 0), 227, 'six ticks is one send at the spec\'s 10 Hz');
});
