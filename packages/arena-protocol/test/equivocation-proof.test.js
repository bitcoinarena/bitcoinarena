// THE PORTABLE PROOF OF EQUIVOCATION - checkpoint.js provesEquivocation on its own (kanban #146, second surface; plan comment
// 189, Go 2026-10-05). It decides the "proven equivocation FORFEIT" path: verify.js calls it on a peer's /checkpoints record
// and at the close, and a true answer takes the stake (§13B). Until now protocol's own suite never called it. The marks are
// signed by the entry's ed25519 session key, from the noble library the nodes load - the only cross-package import.
//
// Read from the source before this file, and measured here first: the decode ran outside the try, so two records of the
// right length whose body is not a checkpoint made the proof REJECT ("not a checkpoint: type N") instead of answering; and
// the injected verify was awaited with no catch, so a verifier that throws rejected the proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../arena-node/node_modules/@noble/curves/ed25519.js';
import {
  encodeCheckpoint, checkpointId, joinSigned, splitSigned, provesEquivocation, NO_PREVIOUS,
  CHECKPOINT_BYTES, SIGNATURE_BYTES, SIGNED_CHECKPOINT_BYTES,
} from '../src/checkpoint.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const SESSION = b32(0x61), OTHER = b32(0x62);
const SESSION_PUB = ed25519.getPublicKey(SESSION);
const verify = (s, m, k) => ed25519.verify(s, m, k);
const mark = (over = {}) => ({ roundId: b32(0x31), entryId: b32(0x32), tick: 1000, stateHash: b32(0x33),
  inputChainHash: b32(0x34), previousHash: b32(0x35), ...over });
const signed = (m, secret = SESSION) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), secret));
const prove = (a, b, o = {}) => provesEquivocation(a, b, o.key || SESSION_PUB, o.verify || verify);
const X = mark();
const Y = mark({ stateHash: b32(0x43) });                                  // same tick, same parent, another world
const Z = mark({ tick: 999, stateHash: b32(0x44) });                       // one tick earlier, same parent

// THE FIRST CHECK (plan 189): a record of the right length that is not a checkpoint is answered, never thrown.
test('a record of the right length whose body is not a checkpoint is refused by name; the proof does not reject', async () => {
  const notType = Uint8Array.from(signed(Y)); notType[0] ^= 1;
  const got = await prove(signed(X), notType);
  assert.equal(got.ok, false);
  assert.match(got.why, /^that is not a signed checkpoint: not a checkpoint: type /);
  const notVersion = Uint8Array.from(signed(Y)); notVersion[2] ^= 1;
  const v = await prove(notVersion, signed(X));
  assert.deepEqual(v, { ok: false, why: 'that is not a signed checkpoint: unknown protocol version' });
});

test('a verifier that throws answers "not signed by that entry"; the proof does not reject', async () => {
  const throwing = () => { throw new Error('malformed key'); };
  assert.deepEqual(await prove(signed(X), signed(Y), { verify: throwing }), { ok: false, why: 'the first mark is not signed by that entry' });
  let n = 0;
  const secondThrows = (s, m, k) => { if (n++ === 1) throw new Error('bad'); return verify(s, m, k); };
  assert.deepEqual(await prove(signed(X), signed(Y), { verify: secondThrows }), { ok: false, why: 'the second mark is not signed by that entry' });
  const rejecting = async () => { throw new Error('rejected'); };
  assert.deepEqual(await prove(signed(X), signed(Y), { verify: rejecting }), { ok: false, why: 'the first mark is not signed by that entry' });
});

test('proven: two marks at one tick, and two chains from one parent at different ticks', async () => {
  const one = await prove(signed(X), signed(Y));
  assert.deepEqual({ ok: one.ok, how: one.how, tick: one.tick, ticks: one.ticks }, { ok: true, how: 'two marks at one tick', tick: 1000, ticks: [1000, 1000] });
  assert.deepEqual(one.ids.map(hex), [hex(checkpointId(X)), hex(checkpointId(Y))]);
  const fork = await prove(signed(X), signed(Z));
  assert.deepEqual({ ok: fork.ok, how: fork.how, tick: fork.tick, ticks: fork.ticks }, { ok: true, how: 'two chains from one parent', tick: 1000, ticks: [1000, 999] });
  assert.deepEqual(fork.ids.map(hex), [hex(checkpointId(X)), hex(checkpointId(Z))]);
  // the order of the two records does not change the verdict
  assert.equal((await prove(signed(Z), signed(X))).ok, true);
  // an async verifier is awaited
  assert.equal((await prove(signed(X), signed(Y), { verify: async (s, m, k) => verify(s, m, k) })).ok, true);
  // a first mark (no parent) and a second first mark at another tick are two chains from one parent, NO_PREVIOUS
  assert.equal((await prove(signed(mark({ tick: 60, previousHash: NO_PREVIOUS })), signed(mark({ tick: 61, previousHash: NO_PREVIOUS, stateHash: b32(9) })))).how,
    'two chains from one parent');
});

test('not proven, by name: a short or missing record, another round or entry, one chain, the same mark twice, unsigned marks', async () => {
  const short = await prove(signed(X).subarray(1), signed(Y));
  assert.deepEqual(short, { ok: false, why: `that is not a signed checkpoint: a signed checkpoint is ${SIGNED_CHECKPOINT_BYTES} bytes, got ${SIGNED_CHECKPOINT_BYTES - 1}` });
  const missing = await prove(signed(X), undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.why, /^that is not a signed checkpoint: /);
  assert.deepEqual(await prove(signed(X), signed(mark({ roundId: b32(0x41), stateHash: b32(0x43) }))), { ok: false, why: 'those two marks are not from the same entry' });
  assert.deepEqual(await prove(signed(X), signed(mark({ entryId: b32(0x42), stateHash: b32(0x43) }))), { ok: false, why: 'those two marks are not from the same entry' });
  const chain = mark({ tick: 1060, previousHash: checkpointId(X), stateHash: b32(0x45) });
  assert.deepEqual(await prove(signed(X), signed(chain)),
    { ok: false, why: 'those two marks are at ticks 1000 and 1060 and name different parents, so they can be one chain' });
  assert.deepEqual(await prove(signed(X), signed(X)), { ok: false, why: 'those are the same mark, sent twice' });
  assert.deepEqual(await prove(signed(X, OTHER), signed(Y)), { ok: false, why: 'the first mark is not signed by that entry' });
  assert.deepEqual(await prove(signed(X), signed(Y, OTHER)), { ok: false, why: 'the second mark is not signed by that entry' });
  const flipped = Uint8Array.from(signed(Y)); flipped[CHECKPOINT_BYTES + 5] ^= 1;
  assert.deepEqual(await prove(signed(X), flipped), { ok: false, why: 'the second mark is not signed by that entry' });
  assert.deepEqual(await prove(signed(X), signed(Y), { key: ed25519.getPublicKey(OTHER) }), { ok: false, why: 'the first mark is not signed by that entry' });
});

test('joinSigned and splitSigned round-trip, and refuse a wrong length by name', () => {
  const body = encodeCheckpoint(X);
  const sig = new Uint8Array(SIGNATURE_BYTES).fill(7);
  const joined = joinSigned(body, sig);
  assert.equal(joined.length, SIGNED_CHECKPOINT_BYTES);
  assert.deepEqual(splitSigned(joined), { body, signature: sig });
  assert.throws(() => joinSigned(body, sig.subarray(1)), { message: `a signature is ${SIGNATURE_BYTES} bytes, got 63` });
  assert.throws(() => splitSigned(joined.subarray(1)), { message: `a signed checkpoint is ${SIGNED_CHECKPOINT_BYTES} bytes, got ${SIGNED_CHECKPOINT_BYTES - 1}` });
});
