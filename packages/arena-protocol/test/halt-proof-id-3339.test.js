// kanban #3339 (feedback #390): a halt proof's id hashed every observer's newest observation, whose height is the tip of that seat's last
// pass. Seats re-sign each pass and hold their peers' copies from different passes, so the 14 seats showed two or three ids for one halt
// (same federation, session, halt height and abandoned guardians), and the ids moved. The id names the halt, not the copies it was read from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../src/hash.js';
import { signHaltObservation, haltProof } from '../src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const federationId = taggedHash('TEST/fed', Uint8Array.of(1));
const record = { federationId, guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i) })) };
const observe = (seat, over = {}) => signHaltObservation({ federationId, session: 41, firstHeight: 341, height: 351, answering: [peer(0), peer(1)],
  observer: seat.pub, ...over }, (h) => schnorr.sign(h, seat.secret));
const opts = { record, censusSeats: seats.map((s) => s.pub), abandonBlocks: 10, verify };

test('#3339 one halt has one proof id, whichever pass of each seat and whichever majority a seat holds', () => {
  const a = haltProof(seats.slice(0, 6).map((s) => observe(s)), opts);
  // the same seats a few passes later (each re-signed at its newest tip), and another majority of the census
  const b = haltProof(seats.slice(0, 6).map((s, i) => observe(s, { height: 351 + 7 * (i + 1) })), opts);
  const c = haltProof(seats.slice(2, 9).map((s) => observe(s, { height: 400 })), opts);
  for (const p of [a, b, c]) assert.equal(p.ok, true, p.why);
  assert.equal(toHex(b.id), toHex(a.id), 'later copies of the same observations');
  assert.equal(toHex(c.id), toHex(a.id), 'another majority of the census');
  // which seats observed it is shown beside the id
  assert.deepEqual(a.observerKeys.map(toHex), seats.slice(0, 6).map((s) => toHex(s.pub)).sort());
  // another halt is another id: a later session, or other guardians abandoned
  const s2 = haltProof(seats.slice(0, 6).map((s) => observe(s, { session: 42 })), opts);
  // (2.0: who is abandoned comes from the guardians' own signed observations, #1289 - not varied here)
  const hh = haltProof(seats.slice(0, 6).map((s) => observe(s, { firstHeight: 345, height: 360 })), opts);
  for (const p of [s2, hh]) { assert.equal(p.ok, true, p.why); assert.notEqual(toHex(p.id), toHex(a.id)); }
});
