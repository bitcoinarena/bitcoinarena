// The transcript: one object, one hash, and it says where it broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { encodeInputBatch, batchId } from '../src/batch.js';
import {
  encodeTranscript, decodeTranscript, transcriptHash, checkTranscript, flatten, GENESIS,
} from '../src/transcript.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const chainOf = (n, per = 3) => {
  const batches = [];
  let prev = GENESIS;
  for (let k = 0; k < n; k++) {
    const first = k * per;
    const b = {
      roundId: b32(1), entryId: b32(2), previousHash: prev, firstTick: first,
      ticks: Array.from({ length: per }, (_, i) => [65536, first + i, 0, 0, 0]),
      liquidations: k === 1 ? [[first + 1, 99 * 65536]] : [],
    };
    batches.push(b);
    prev = batchId(b);
  }
  return { roundId: b32(1), entryId: b32(2), batches };
};

test('a transcript survives the round trip and keeps its hash', () => {
  const t = chainOf(4);
  const back = decodeTranscript(encodeTranscript(t));
  assert.equal(toHex(transcriptHash(back)), toHex(transcriptHash(t)));
  assert.deepEqual(checkTranscript(back), { ok: true, ticks: 12 });
});

test('a broken link is named, not merely refused', () => {
  const t = chainOf(4);
  t.batches[2] = { ...t.batches[2], previousHash: b32(9) };
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.equal(r.at, 2, 'the verifier is told which batch, not asked to bisect');
  assert.match(r.why, /chain is broken/);
});

test('a batch removed from the middle breaks the chain at that place', () => {
  const t = chainOf(4);
  t.batches.splice(2, 1);
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.equal(r.at, 2);
});

test('a batch from another round or another player is refused', () => {
  const a = chainOf(2);
  a.batches[1] = { ...a.batches[1], roundId: b32(8) };
  assert.match(checkTranscript(a).why, /another round/);
  const b = chainOf(2);
  b.batches[1] = { ...b.batches[1], entryId: b32(8) };
  assert.match(checkTranscript(b).why, /another entry/);
});

test('a tick that is out of step is named with both numbers', () => {
  const t = chainOf(2);
  const second = { ...t.batches[1], firstTick: 99 };
  second.previousHash = t.batches[1].previousHash;
  t.batches[1] = second;
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.match(r.why, /expected tick 3, got 99/);
});

test('flatten gives exactly what the core takes, in tick order', () => {
  const t = chainOf(3);
  const f = flatten(t);
  assert.equal(f.firstTick, 0);
  assert.equal(f.ticks.length, 9);
  assert.deepEqual(f.ticks[0], [65536, 0, 0, 0, 0]);
  assert.deepEqual(f.ticks[8], [65536, 8, 0, 0, 0]);
  assert.deepEqual(f.liquidations, [[4, 99 * 65536]]);
});

test('flatten rebases the liquidation ticks to the array it hands back', () => {
  // On the wire they are absolute, because absolute is what makes a repeat
  // harmless. A replay walks the array from zero, so a transcript that begins
  // at tick 50 would otherwise put a strike at index 51 of a short array -
  // nowhere - and replay to a different round with nothing to say so.
  const t = chainOf(2);
  for (const b of t.batches) b.firstTick += 50;
  t.batches[1].liquidations = [[54, 7]];
  const f = flatten(t);
  assert.equal(f.firstTick, 50, 'the caller can still say where the round began');
  assert.deepEqual(f.liquidations, [[4, 7]], 'but the index is into `ticks`');
});

test('the same batches always give the same transcript hash', () => {
  assert.equal(toHex(transcriptHash(chainOf(5))), toHex(transcriptHash(chainOf(5))));
  assert.notEqual(toHex(transcriptHash(chainOf(5))), toHex(transcriptHash(chainOf(4))));
});

test('anything after the transcript is refused', () => {
  const bytes = encodeTranscript(chainOf(2));
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => decodeTranscript(longer), /trailing bytes/);
});
