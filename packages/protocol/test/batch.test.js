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
  loads: [[120, 17314, 42]],
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

/**
 * THE LOAD, WHICH IS WHY A REPLAY IS HUNTED AT ALL.
 *
 * Heat was a host write straight into the page's core - in no batch, no mark
 * and no transcript - so the page carried 57229 and every replay of the same
 * inputs carried 0. What crosses is the bed rather than the answer: the sats
 * aboard and hundredths of a BTC, at the tick they were declared, and the core
 * decides the cost.
 */
test('the load is carried, sorted, and part of what a batch commits to', () => {
  const b = sample();
  const back = decodeInputBatch(encodeInputBatch(b));
  assert.deepEqual(back.loads, b.loads);

  // A batch with no load is a real batch - most of them are - and it must not
  // encode as one that forgot the field.
  const empty = { ...sample(), loads: [] };
  assert.deepEqual(decodeInputBatch(encodeInputBatch(empty)).loads, []);
  assert.notEqual(toHex(batchId(b)), toHex(batchId(empty)),
    'a run declaring a load and one declaring none hash the same');

  // Sorted before it is hashed, for the liquidations' reason: two nodes that
  // received the same declarations in a different order encode the same bytes.
  const one = { ...sample(), loads: [[120, 17314, 42], [300, 9000, 0]] };
  const other = { ...sample(), loads: [[300, 9000, 0], [120, 17314, 42]] };
  assert.equal(toHex(batchId(one)), toHex(batchId(other)));

  // And a changed bed is a changed batch, or a load could be swapped after the
  // chain was built.
  const fatter = { ...sample(), loads: [[120, 17315, 42]] };
  assert.notEqual(toHex(batchId(b)), toHex(batchId(fatter)));
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
    loads: Array.from({ length: MAX_BATCH_TICKS }, (_, i) => [i, 1, 0]),
  };
  assert.equal(encodeInputBatch(b).length, MAX_INPUT_BATCH_BYTES);
  assert.equal(MAX_INPUT_BATCH_BYTES, 2621509);
});

test('a tick costs twenty bytes, a liquidation eight and a load twelve', () => {
  const at = (n, l, d = 0) => encodeInputBatch({
    roundId: b32(7), entryId: b32(9), previousHash: new Uint8Array(32), firstTick: 0,
    ticks: Array.from({ length: n }, () => [65536, 0, 0, 0, 0]),
    liquidations: Array.from({ length: l }, (_, i) => [i, 1]),
    loads: Array.from({ length: d }, (_, i) => [i, 1, 0]),
  }).length;
  assert.equal(at(0, 0), 109, 'the header, and the load vector\'s own length word');
  assert.equal(at(1, 0) - at(0, 0), 20);
  assert.equal(at(0, 1) - at(0, 0), 8);
  assert.equal(at(0, 0, 1) - at(0, 0), 12);
  assert.equal(at(6, 0), 229, 'six ticks is one send at the spec\'s 10 Hz');
});
