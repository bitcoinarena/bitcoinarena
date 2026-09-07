// The transcript: one object, one hash, and it says where it broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { encodeInputBatch, batchId } from '../src/batch.js';
import {
  encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from '../src/checkpoint.js';
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
  assert.deepEqual(checkTranscript(back), { ok: true, ticks: 12, marks: 0, throughTick: null });
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

// ---------------------------------------------------------------------------
// AND THE CHECKPOINT CHAIN, which §13C names first.
//
// The canonical transcript is "the longest checkpoint chain that carries
// receipts from at least 5 committee nodes, together with the input batches
// whose hashes it commits to". Until the marks went in, this object was the
// second half only, and the cost was measured: three nodes carrying three
// different mark chains over one set of batches - including one whose player
// had committed to a different world at the last tick - produced ONE
// transcript hash, and therefore one result id for a committee to sign.
//
// No curve is used here and none is needed: `checkTranscript` checks the
// chain, the ticks and what the marks commit to. Who signed them is the
// caller's business, and the session key that answers it lives in the entry.

const sigOf = (n) => new Uint8Array(64).fill(n);

/** A signed mark, chained onto `parent`, committing to input head `input`. */
const markOf = (tick, state, parent, input, sig = 1) => joinSigned(
  encodeCheckpoint({
    roundId: b32(1), entryId: b32(2), tick, stateHash: b32(state),
    inputChainHash: input, previousHash: parent,
  }),
  sigOf(sig));

const bodyAt = (tick, state, parent, input) => ({
  roundId: b32(1), entryId: b32(2), tick, stateHash: b32(state),
  inputChainHash: input, previousHash: parent,
});

/** The signed chain over a list of input heads, one mark each, ticks 0,3,6... */
const chainOver = (heads, states) => {
  const marks = [];
  let parent = NO_PREVIOUS;
  for (let i = 0; i < heads.length; i++) {
    const c = bodyAt(i * 3, states[i], parent, heads[i]);
    marks.push(joinSigned(encodeCheckpoint(c), sigOf(1)));
    parent = checkpointId(c);
  }
  return marks;
};

const headsOf = (t) => [GENESIS, ...t.batches.map(batchId)];

/** `chainOf(n)` plus a mark on each batch head, the first before any input. */
const markedChainOf = (n, states = null) => {
  const t = chainOf(n);
  const heads = headsOf(t);
  t.marks = chainOver(heads, heads.map((_, i) => (states ? states[i] : 0x10 + i)));
  return t;
};

test('the marks survive the round trip and the check reports the chain', () => {
  const t = markedChainOf(3);
  const back = decodeTranscript(encodeTranscript(t));
  assert.equal(back.marks.length, 4, 'one before any input, then one per batch');
  assert.equal(toHex(transcriptHash(back)), toHex(transcriptHash(t)));
  assert.deepEqual(checkTranscript(back), { ok: true, ticks: 9, marks: 4, throughTick: 9 });
});

test('two nodes that carried different mark chains no longer agree on the hash', () => {
  // The measurement that put the marks in this object. Same three batches in
  // all three, so the input half is byte-identical.
  const a = markedChainOf(3);                       // four marks
  const b = { ...a, marks: a.marks.slice(0, 3) };   // this node carried three
  const c = markedChainOf(3, [0x10, 0x11, 0x12, 0x99]); // a different last world

  const hashes = [a, b, c].map((t) => toHex(transcriptHash(t)));
  assert.equal(new Set(hashes).size, 3, 'three carried chains, three hashes');
  assert.equal(
    toHex(transcriptHash({ ...a, marks: [] })),
    toHex(transcriptHash({ ...c, marks: [] })),
    'and the batches alone - what this used to hash - really are the same');

  // `b` is a shorter chain, not a broken one: it just stops earlier. That is
  // the case §13C's "node A saw more than node B" is about, and the answer is
  // that the two objects are different objects, not that one is invalid.
  assert.equal(checkTranscript(b).ok, false, 'but it carries a batch no mark stands behind');
  assert.match(checkTranscript(b).why, /commits through batch 2 and the transcript carries 3/);
});

test('a signature is inside the hash, because the served bytes are what is pinned', () => {
  const t = markedChainOf(2);
  const other = { ...t, marks: [...t.marks] };
  const m = new Uint8Array(other.marks[1]);
  m[m.length - 1] ^= 1;
  other.marks[1] = m;
  assert.notEqual(toHex(transcriptHash(other)), toHex(transcriptHash(t)));
  assert.equal(checkTranscript(other).ok, true, 'the chain is unchanged: no curve is checked here');
});

test('a broken mark chain is named as a mark, not as a batch', () => {
  const t = markedChainOf(3);
  t.marks[2] = markOf(6, 0x12, b32(0xee), headsOf(t)[2]);
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.equal(r.in, 'mark', 'the two chains are numbered separately');
  assert.equal(r.at, 2);
  assert.match(r.why, /mark chain is broken/);
});

test('a mark from another round or another player is refused', () => {
  for (const [field, why] of [['roundId', /another round/], ['entryId', /another entry/]]) {
    const t = markedChainOf(1);
    const c = { ...bodyAt(0, 0x10, NO_PREVIOUS, GENESIS), [field]: b32(8) };
    t.marks[0] = joinSigned(encodeCheckpoint(c), sigOf(1));
    assert.match(checkTranscript(t).why, why);
    assert.equal(checkTranscript(t).in, 'mark');
  }
});

test('a mark that does not come after the one before it is refused', () => {
  const t = markedChainOf(2);
  const first = bodyAt(0, 0x10, NO_PREVIOUS, GENESIS);
  t.marks[1] = markOf(0, 0x11, checkpointId(first), headsOf(t)[1]);
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.match(r.why, /tick 0 does not come after 0/, 'the same tick twice is 13B, not a chain');
});

test('a mark that commits to inputs the transcript does not carry is refused', () => {
  // §11: "a transcript whose inputs were never published cannot be replayed
  // and therefore cannot be finalized as a win". Withholding is refused by
  // the object rather than by whoever remembers to ask.
  const t = markedChainOf(2);
  t.marks[1] = markOf(3, 0x11, checkpointId(bodyAt(0, 0x10, NO_PREVIOUS, GENESIS)), b32(0x77));
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.equal(r.at, 1);
  assert.match(r.why, /inputs this transcript does not carry/);
});

test('a mark that commits to earlier inputs than the one before it is a rewind', () => {
  const t = markedChainOf(3);
  const h = headsOf(t);
  // Same four marks, but the last names the FIRST batch's head again. Two
  // marks on ONE head is legal - a mark can be taken with no input between -
  // so what is refused is going backwards, not standing still.
  const chain = chainOver([h[0], h[1], h[2], h[1]], [0x10, 0x11, 0x12, 0x13]);
  const r = checkTranscript({ ...t, marks: chain });
  assert.equal(r.ok, false);
  assert.equal(r.at, 3, 'the mark that went backwards is the one named');
  assert.match(r.why, /earlier inputs than the one before it/);
});

test('inputs past the last carried mark are refused', () => {
  // A node may not pad the canonical object with batches no mark stands
  // behind: a replay would be handed ticks nobody receipted.
  const t = markedChainOf(3);
  t.batches.push({
    roundId: b32(1), entryId: b32(2), previousHash: batchId(t.batches[2]), firstTick: 9,
    ticks: [[65536, 9, 0, 0, 0]], liquidations: [],
  });
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.equal(r.in, 'mark');
  assert.match(r.why, /commits through batch 3 and the transcript carries 4/);
});

test('a record that is not a whole signed mark is refused by length', () => {
  const t = markedChainOf(1);
  t.marks[0] = t.marks[0].subarray(0, SIGNED_CHECKPOINT_BYTES - 1);
  const r = checkTranscript(t);
  assert.equal(r.ok, false);
  assert.match(r.why, new RegExp(`is not a ${SIGNED_CHECKPOINT_BYTES}-byte signed mark`));
  assert.throws(() => encodeTranscript(t), /230/, 'and it cannot be encoded either');
});
