// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "ANSWERING" IN A HALT PROOF MEANS SIGNING, NOT REACHABILITY (spec §23A.5, RULED 2026-11-07 kanban #1289; kanban #1319): every live
// guardian signs its own view (the peers it sees in P2P consensus) with the node key its record names; the largest mutually
// attesting subset of the signers is spared, everyone else is ABANDONED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../src/hash.js';
import { signHaltObservation, signGuardianHaltObservation, encodeGuardianHaltObservation, decodeGuardianHaltObservation,
  haltProof, largestMutualSubsets } from '../src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/halt1319', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer1319', Uint8Array.of(i))]);
const federationId = taggedHash('TEST/fed1319', Uint8Array.of(1));
const N = 4;                                             // 3 of 4: f = 1
const nodes = Array.from({ length: N }, (_, i) => key(`node${i}`));
const record = { federationId, guardians: nodes.map((n, i) => ({ peerKey: peer(i), nodePubkey: n.pub })) };
// five seats prove the halt at session 41 from 344; their `answering` (reachability) names g2 and g3 - it no longer decides anything
const seatObs = seats.slice(0, 5).map((s, i) => signHaltObservation({ federationId, session: 41, firstHeight: 340 + i, height: 351 + i,
  answering: [peer(2), peer(3)], observer: s.pub }, (h) => schnorr.sign(h, s.secret)));
const view = (i, seen, over = {}) => signGuardianHaltObservation({ federationId, session: 41, firstHeight: 341, height: 352,
  peersSeen: seen.map(peer), guardian: peer(i), ...over }, (h) => schnorr.sign(h, (over.signer || nodes[i]).secret));
const proof = (guardianObservations, extra = {}) => haltProof(seatObs, { record, censusSeats: seats.map((s) => s.pub), abandonBlocks: 10, verify,
  guardianObservations, ...extra });
const names = (keys) => keys.map((k) => [0, 1, 2, 3].find((i) => toHex(peer(i)) === toHex(k))).sort();

test('f + 1 guardians with P2P blocked are slashed though the seats reach their API; the two in consensus are spared', () => {
  // g2 and g3 (f + 1 = 2) are cut off in P2P: each signs a view that sees no one. g0 and g1 see each other.
  const p = proof([view(0, [1]), view(1, [0]), view(2, []), view(3, [])]);
  assert.equal(p.ok, true, p.why);
  assert.equal(p.signers, 4); assert.equal(p.largestSubset, 2);
  assert.deepEqual(names(p.answered), [0, 1]);
  assert.deepEqual(names(p.abandoned), [2, 3], 'the seats reached g2 and g3, and they are slashed anyway: reachability is not signing');
});

test('a stub that answers session_count and signs nothing is ABANDONED; a partitioned honest guardian that signs is not', () => {
  // the seats reach g2 and g3 (their `answering` says so); g3 is a stub that signs nothing. g0 is cut off from the seats but
  // in P2P consensus with g1 and g2, and signs.
  const p = proof([view(0, [1, 2]), view(1, [0, 2]), view(2, [0, 1])]);
  assert.deepEqual(names(p.answered), [0, 1, 2], 'g0 signed and is seen by g1 and g2: not slashed, though no seat reached it');
  assert.deepEqual(names(p.abandoned), [3], 'g3 answered the seats and signed nothing: gone');
  const none = proof([]);
  assert.deepEqual(names(none.abandoned), [0, 1, 2, 3], 'no guardian signs: every one is gone');
});

test('mutual means both ways: one-sided claims do not join a subset; a tie spares both sides', () => {
  // g0 claims to see everyone; nobody names g0 - g0 sits alone
  const lone = proof([view(0, [1, 2, 3]), view(1, [2]), view(2, [1]), view(3, [])]);
  assert.deepEqual(names(lone.answered), [1, 2]); assert.deepEqual(names(lone.abandoned), [0, 3]);
  // {g0, g1} and {g2, g3}: two subsets of the largest size, no member of either is slashed
  const tie = proof([view(0, [1]), view(1, [0]), view(2, [3]), view(3, [2])]);
  assert.equal(tie.largestSubset, 2); assert.deepEqual(names(tie.answered), [0, 1, 2, 3]); assert.deepEqual(tie.abandoned, []);
  // a path a - b - c (a and c do not see each other): {a, b} and {b, c} tie at 2, all three spared
  const path = largestMutualSubsets(new Map([['a', new Set(['b'])], ['b', new Set(['a', 'c'])], ['c', new Set(['b'])]]));
  assert.equal(path.size, 2); assert.deepEqual([...path.members].sort(), ['a', 'b', 'c']);
});

test('a view counts only when its guardian signed it with the record\'s node key, at session S, in the halt window', () => {
  const stranger = key('not a guardian node');
  const forged = view(1, [0], { signer: stranger });                       // g1's peer key, a stranger's node key
  const p1 = proof([view(0, [1]), forged]);
  assert.deepEqual(names(p1.answered), [0], 'the forged view of g1 is not counted: g0 alone is the largest subset');
  assert.deepEqual(names(proof([view(0, [1]), view(1, [0], { session: 40 })]).answered), [0], 'a view at another session does not count');
  assert.deepEqual(names(proof([view(0, [1]), view(1, [0], { firstHeight: 300, height: 343 })]).answered), [0],
    'a view signed before the halt height (344) does not count');
  const outsider = { federationId, session: 41, firstHeight: 341, height: 352, peersSeen: [peer(0)], guardian: peer(9) };
  const p2 = proof([view(0, [1]), view(1, [0]), signGuardianHaltObservation(outsider, (h) => schnorr.sign(h, stranger.secret))]);
  assert.deepEqual(names(p2.answered), [0, 1], 'a guardian outside the record is not counted');
  // one view per guardian, the newest
  const p3 = proof([view(0, [1]), view(1, []), view(1, [0], { height: 360 })]);
  assert.deepEqual(names(p3.answered), [0, 1]);
});

test('a guardian view round-trips its bytes, its peers sorted; a bad one is refused', () => {
  const o = view(2, [3, 0, 1]);
  const back = decodeGuardianHaltObservation(encodeGuardianHaltObservation(o));
  assert.equal(back.session, 41); assert.equal(toHex(back.guardian), toHex(peer(2)));
  assert.deepEqual(back.peersSeen.map(toHex), [...o.peersSeen].map(toHex));
  assert.throws(() => encodeGuardianHaltObservation({ ...o, firstHeight: 400 }), /first seen after/);
  assert.throws(() => encodeGuardianHaltObservation({ ...o, guardian: new Uint8Array(32) }), /own peer key \(33\)/);
});
