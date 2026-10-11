// RESERVE SEATS (§5A.7, kanban #301): the draw, PRESENT, the seated, the SEATING certificate and its equivocation, on the
// protocol's own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { drawnForRole } from '../src/sortition.js';
import { signPresent, verifyPresent, decodePresent, seatedFrom, signSeating, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, seatedThreshold } from '../src/seating.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const drawn = nodes.map((n) => n.pubkey);
const sign = (n) => (m) => schnorr.sign(m, n.secret);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const roundId = new Uint8Array(32).fill(0x42);
const cert = (seated, signers = seated) => encodeSeatingCertificate({ roundId, role: 'game', seated,
  signatures: signers.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId, role: 'game', seated }, sign(nodes.find((n) => n.pubkey === k))) })) });
const check = { roundId, role: 'game', drawn, slots: 7, verify };

test('a role draws 9 for 7 seats and 3 for 2 - two reserves, never past 2 x threshold - 1', () => {
  assert.equal(drawnForRole({ gameVerifySlots: 7, settlementSlots: 7 }, 'game'), 9);
  assert.equal(drawnForRole({ gameVerifySlots: 7, settlementSlots: 7 }, 'settlement'), 9);
  assert.equal(drawnForRole({ gameVerifySlots: 2, settlementSlots: 2 }, 'settlement'), 3);
  for (const slots of [2, 7]) assert.ok(2 * seatedThreshold(slots) > drawnForRole({ gameVerifySlots: slots }, 'game'));
});

test('PRESENT: signed by the node it names, for one round and role; anything else refused', () => {
  const p = signPresent({ roundId, role: 'settlement', nodePubkey: nodes[3].pubkey }, sign(nodes[3]));
  assert.equal(verifyPresent(p, { roundId, verify }).ok, true);
  assert.equal(decodePresent(p).role, 'settlement');
  const forged = signPresent({ roundId, role: 'settlement', nodePubkey: nodes[3].pubkey }, sign(nodes[4]));
  assert.match(verifyPresent(forged, { roundId, verify }).why, /not signed by the node it names/);
  assert.match(verifyPresent(p, { roundId: new Uint8Array(32), verify }).why, /another round/);
  assert.equal(seatingCloseMs({ startTimeMs: 1000000n }), 880000n);
});

test('the seated: the first min(7, present) present in score order - an offline drawn node is replaced by a reserve', () => {
  assert.deepEqual(seatedFrom({ drawn, present: drawn, slots: 7 }), drawn.slice(0, 7), 'all present: the first 7');
  const two = [drawn[1], drawn[4]];   // two drawn nodes offline
  const present = drawn.filter((k) => !two.includes(k));
  assert.deepEqual(seatedFrom({ drawn, present, slots: 7 }), [drawn[0], drawn[2], drawn[3], drawn[5], drawn[6], drawn[7], drawn[8]], 'reserves 8 and 9 seated');
  assert.equal(seatedFrom({ drawn, present: drawn.slice(0, 4), slots: 7 }).length, 4);
});

test('a certificate stands only with every seated node\'s signature, in score order, between the threshold and the seats', () => {
  const seated = drawn.slice(0, 7);
  assert.equal(verifySeating(cert(seated), check).ok, true);
  assert.match(verifySeating(cert(seated, seated.slice(0, 6)), check).why, /did not sign that seating/);
  assert.match(verifySeating(cert(drawn.slice(0, 4)), check).why, /fewer than the 5 a round needs: it opens no entries/);
  assert.match(verifySeating(cert(drawn.slice(0, 8)), check).why, /more than the round's 7 seats/);
  assert.match(verifySeating(cert([drawn[1], drawn[0], ...drawn.slice(2, 7)]), check).why, /not in score order/);
  const stranger = schnorr.getPublicKey(new Uint8Array(32).fill(99));
  assert.match(verifySeating(encodeSeatingCertificate({ roundId, role: 'game', seated: [...drawn.slice(0, 6), stranger], signatures: [] }), check).why, /which the draw did not draw/);
  assert.match(verifySeating(cert(seated), { ...check, role: 'settlement' }).why, /for game, not settlement/);
});

test('two seatings for one round and role: proof of equivocation by the nodes that signed both', () => {
  const a = cert(drawn.slice(0, 7));
  const b = cert([drawn[0], drawn[1], drawn[2], drawn[3], drawn[4], drawn[7], drawn[8]]);
  const e = seatingEquivocation(a, b, check);
  assert.equal(e.ok, true);
  assert.equal(e.signers.length, 5, 'the five both seat signed both');
  assert.match(seatingEquivocation(a, a, check).why, /one seating twice/);
});
