// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER REPLAY MAP (kanban #3583): only the owner's requests (and a claim with the right code) are kept; they stay refused as replays for
// the whole window, in both forms (signed message and NIP-98 style kind 27235 event); old ones are dropped from the front; the map is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createOwner, ownerSecretFromSeed, signOwnerRequest, signOwnerEvent, OWNER_WINDOW_MS, OWNER_USED_MAX } from '../src/owner.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { utf8Encode } from '../../arena-protocol/src/utf8.js';

const sign = (m, s) => schnorr.sign(m, s);
const pubkeyOf = (s) => schnorr.getPublicKey(s);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const NODE = 'ab'.repeat(32);
const ownerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
const strangerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(9));

const setup = (usedMax) => {
  const clock = { now: 5_000_000 };
  const m = { owner: null, code: null };
  const store = { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } };
  const o = createOwner({ store, verify, node: NODE, nowMs: () => clock.now, ...(usedMax ? { usedMax } : {}) });
  const req = (secret, action, args = {}, atMs = clock.now) => signOwnerRequest({ node: NODE, action, args, atMs, secret, sign, pubkeyOf });
  return { clock, m, o, req };
};
// a kind 27235 event signed by `secret` (NIP-01 id, BIP-340 sig)
const signEventWith = (secret) => (t) => {
  const pubkey = toHex(pubkeyOf(secret));
  const id = toHex(sha256(utf8Encode(JSON.stringify([0, pubkey, t.created_at, t.kind, t.tags, t.content]))));
  return { ...t, pubkey, id, sig: toHex(schnorr.sign(fromHex(id), secret)) };
};

test('a claim with a wrong code is not kept; with the right one it is, and its replay is refused', () => {
  const { m, o, req } = setup();
  const wrong = req(strangerSecret, 'claim', { code: 'WRONG-CODE-0000' });
  assert.equal(o.claim(wrong).status, 403);
  assert.equal(o.claim(wrong).status, 403, 'refused for the code again, not as a replay');
  const right = req(ownerSecret, 'claim', { code: m.code });
  assert.ok(o.claim(right).ok);
  assert.equal(o.authorize(right, 'claim').status, 401, 'the claim request cannot be replayed at a door');
  assert.match(o.authorize(right, 'claim').why, /already sent/);
});

test('the owner\'s requests stay refused as replays for the whole window, in both forms', async () => {
  const { clock, m, o, req } = setup();
  assert.ok(o.claim(req(ownerSecret, 'claim', { code: m.code })).ok);
  const a = req(ownerSecret, 'stay', { n: 1 });
  const e = await signOwnerEvent({ node: NODE, action: 'stay', args: { n: 2 }, atMs: clock.now, signEvent: signEventWith(ownerSecret) });
  assert.ok(o.stay(a).ok);
  assert.ok(o.stay(e).ok);
  for (const dt of [0, 1000, OWNER_WINDOW_MS - 1000]) {
    clock.now += dt;
    assert.match(o.stay(a).why, /already sent/, `a signed request replayed after ${dt} ms`);
    assert.match(o.stay(e).why, /already sent/, `a Nostr request replayed after ${dt} ms`);
  }
  // a stranger's well-formed Nostr event is refused as not the owner's, and again so (nothing kept)
  const se = await signOwnerEvent({ node: NODE, action: 'stay', args: {}, atMs: clock.now, signEvent: signEventWith(strangerSecret) });
  assert.equal(o.stay(se).status, 403);
  assert.equal(o.stay(se).status, 403);
  // a forged signature under the owner's key is still 401 and is not kept
  const forged = { ...req(ownerSecret, 'stay', { n: 3 }), sig: '00'.repeat(64) };
  assert.equal(o.stay(forged).status, 401);
  assert.match(o.stay(forged).why, /signature/);
});

test('out-of-order request times: no entry is dropped while its request is still in the clock window', () => {
  const { clock, m, o, req } = setup();
  assert.ok(o.claim(req(ownerSecret, 'claim', { code: m.code })).ok);
  const late = req(ownerSecret, 'stay', { n: 'late' }, clock.now + OWNER_WINDOW_MS);   // signed ahead of the seat's clock, kept
  const early = req(ownerSecret, 'stay', { n: 'early' }, clock.now - OWNER_WINDOW_MS);
  assert.ok(o.stay(late).ok);
  assert.ok(o.stay(early).ok);
  // 2 windows on: `early` is old enough to go; `late` is still inside the clock window and must still be refused as a replay
  clock.now += 2 * OWNER_WINDOW_MS;
  assert.ok(o.stay(req(ownerSecret, 'stay', { n: 'tick' })).ok);
  assert.match(o.stay(late).why, /already sent/);
});

test('the map is bounded: full, a new owner request is refused (429) and none kept is evicted; it frees as the window passes', () => {
  assert.ok(Number.isInteger(OWNER_USED_MAX) && OWNER_USED_MAX >= 1000, 'the seat\'s bound leaves the owner room');
  const MAX = 8;   // a small bound for the test; the seat runs with OWNER_USED_MAX
  const { clock, m, o, req } = setup(MAX);
  assert.ok(o.claim(req(ownerSecret, 'claim', { code: m.code })).ok);   // 1 entry
  const first = req(ownerSecret, 'stay', { n: 0 });
  assert.ok(o.stay(first).ok);
  let i = 1;
  for (; i < MAX - 1; i++) assert.ok(o.stay(req(ownerSecret, 'stay', { n: i })).ok);
  const over = o.stay(req(ownerSecret, 'stay', { n: 'over' }));
  assert.equal(over.status, 429);
  assert.match(o.stay(first).why, /already sent/, 'a kept request is still refused when the map is full');
  clock.now += 2 * OWNER_WINDOW_MS + 1;
  assert.ok(o.stay(req(ownerSecret, 'stay', { n: 'after' })).ok, 'the window passed: room again');
});
