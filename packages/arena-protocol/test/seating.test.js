// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESERVE SEATS (§5A.7): the draw, PRESENT, the seated, the SEATING certificate and its equivocation, on the
// protocol's own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { drawnForRole } from '../src/sortition.js';
import { signPresent, verifyPresent, decodePresent, seatedFrom, signSeating, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, seatedThreshold, seatingId, signSeen, decodeSeatingCertificate, seatingSignedTwice, verifyJustification,
  encodeJustification, decodeJustification } from '../src/seating.js';
import { toHex } from '../src/hash.js';

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

// NO RULE MAY EVER SLASH AN HONEST SEAT (kanban #738, RULED 2026-10-28, protocol 22). Nine drawn, seven seats. The honest seats 0,
// 2, 4 and 5 hold five PRESENTs at the close and sign S = {0, 1, 2, 4, 5}; the Byzantine B = 1 signs T = {0..6}, which does not come
// before S, so S can never stand and they move on to S' = T, each with B's signed T as its justification. Then B signs S as well:
// S and S' both complete, and they share 0, 1, 2, 4 and 5.
const S = [0, 1, 2, 4, 5].map((i) => drawn[i]), T = drawn.slice(0, 7), B = drawn[1];
const sigOver = (seated, k) => signSeating({ roundId, role: 'game', seated }, sign(nodes.find((n) => n.pubkey === k)));
// a 22 certificate: every seated node also signs who it held a PRESENT of (here: the seated)
const cert22 = (seated, justifications = null, sigs = new Map()) => encodeSeatingCertificate({ roundId, role: 'game', seated, justifications,
  signatures: seated.map((k) => ({ nodePubkey: k, signature: sigs.get(k) || sigOver(seated, k) })),
  seen: [{ present: seated, leftOut: [], signatures: seated.map((k) => ({ nodePubkey: k,
    signature: signSeen({ roundId, role: 'game', seating: seatingId({ roundId, role: 'game', seated }), present: seated, leftOut: [] }, sign(nodes.find((n) => n.pubkey === k))) })) }] });
const byB = sigOver(T, B);
const why = { of: S, seated: T, member: B, signature: byB, nested: null };
const honestLeft = [0, 2, 4, 5].map((i) => drawn[i]);
const check22 = { ...check, listsPresent: true };

test('kanban #738 (protocol 22): B kills S with T and signs S too - the proof by S and S\' names B, never the honest seats that left S with B\'s T', () => {
  const a = cert22(S), b = cert22(T, honestLeft.map((k) => ({ nodePubkey: k, justification: why })), new Map([[B, byB]]));
  assert.equal(verifySeating(a, check22).ok, true);
  const vb = verifySeating(b, check22);
  assert.equal(vb.ok, true, vb.why);
  const e = seatingEquivocation(a, b, check22);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex), [toHex(B)], 'the proof stands against B alone');
  assert.deepEqual(e.excused.map(toHex).sort(), honestLeft.map(toHex).sort(), 'each honest seat\'s second signature carries B\'s T: excused');
  assert.ok(e.signedTwice.some((x) => toHex(x.node) === toHex(B) && x.certificate === 'a' && x.seated.map(toHex).join() === T.map(toHex).join()), 'T and S: B\'s own equivocation');
  // the same proof, T against S, on its own: B signed the certificate of S and T, with no reason
  assert.equal(seatingSignedTwice(a, { node: B, seated: T, signature: byB }, check22).ok, true);
  // and never against an honest seat: H's signature over T carries the justification
  const H = drawn[0];
  const r = seatingSignedTwice(a, { node: H, seated: T, signature: sigOver(T, H), justification: why }, check22);
  assert.equal(r.ok, false); assert.match(r.why, /carries a justification/);
  // the certificates' order does not matter
  const e2 = seatingEquivocation(b, a, check22);
  assert.deepEqual([e2.signers.map(toHex), e2.signedTwice[0].certificate], [[toHex(B)], 'b']);
});

test('kanban #738 (protocol 22): a member whose own T was a second signature is excused by its own justification, carried nested - the chain ends at B', () => {
  // M = 2 left S for T because B signed T; H = 0 left S because M signed T, and carries M's justification inside its own
  const M = drawn[2], byM = sigOver(T, M);
  const viaM = { of: S, seated: T, member: M, signature: byM, nested: why };
  const ju = [{ nodePubkey: drawn[0], justification: viaM }, ...[2, 4, 5].map((i) => ({ nodePubkey: drawn[i], justification: why }))];
  const b = cert22(T, ju, new Map([[B, byB], [M, byM]]));
  assert.equal(verifySeating(b, check22).ok, true);
  const e = seatingEquivocation(cert22(S), b, check22);
  assert.deepEqual(e.signers.map(toHex), [toHex(B)]);
  assert.ok(e.excused.some((k) => toHex(k) === toHex(M)));
  // without its nested reason, the member it names is the one proved against
  const bare = cert22(T, [{ nodePubkey: drawn[0], justification: { ...viaM, nested: null } }, ...[4, 5].map((i) => ({ nodePubkey: drawn[i], justification: why }))], new Map([[B, byB], [M, byM]]));
  assert.deepEqual(seatingEquivocation(cert22(S), bare, check22).signers.map(toHex).sort(), [toHex(B), toHex(M)].sort());
});

test('kanban #738 (protocol 22): a forged justification stands for nothing - not by a member of S, a T before S, a bad signature, an S\' not after S', () => {
  const stranger = drawn[8], H = drawn[0];
  const on = { roundId, role: 'game', drawn, slots: 7, verify, signer: H, onto: T };
  assert.equal(verifyJustification(why, on).ok, true);
  const T8 = [0, 1, 2, 3, 4, 5, 8].map((i) => drawn[i]);
  assert.match(verifyJustification({ ...why, seated: T8, member: stranger, signature: sigOver(T8, stranger) }, on).why, /not in the seating it says can never stand/);
  const before = [0, 1, 2, 4].map((i) => drawn[i]);                 // fewer seated: it comes before S
  assert.match(verifyJustification({ ...why, seated: before, signature: sigOver(before, B) }, on).why, /comes before the seating left/);
  assert.match(verifyJustification({ ...why, signature: sigOver(T, drawn[3]) }, on).why, /signature is not/);
  assert.match(verifyJustification(why, { ...on, onto: [0, 1, 2, 4, 6].map((i) => drawn[i]) }).why, /does not come after/);
  assert.match(verifyJustification({ ...why, member: H, signature: sigOver(T, H) }, on).why, /names the signer itself/);
  // a certificate that carries a forged one does not stand
  const forged = cert22(T, [{ nodePubkey: H, justification: { ...why, signature: sigOver(T, drawn[3]) } }]);
  assert.match(verifySeating(forged, check22).why, /justification does not stand/);
  // the wire form round-trips
  const back = decodeJustification(encodeJustification({ ...why, nested: why }));
  assert.deepEqual([back.member, back.nested.member].map(toHex), [toHex(B), toHex(B)]);
});

test('kanban #738: below protocol 22 nothing carries a justification - the certificate is byte for byte as before', () => {
  const seated = drawn.slice(0, 7);
  const sigs = seated.map((k) => ({ nodePubkey: k, signature: sigOver(seated, k) }));
  assert.deepEqual(encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs, justifications: [] }),
    encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs }));
  assert.throws(() => encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs, justifications: [{ nodePubkey: drawn[0], justification: why }] }), /only with who was present/);
  assert.equal(decodeSeatingCertificate(encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs })).justifications, null);
});

// A CHAIN OF DEPARTURES EXCUSES (kanban #744, RULED 2026-10-28). Honest M = 0 signs S5 = {0..4}, then S6 = {0..5} because the
// Byzantine B = 4 (in S5) signed S6, then S7 = {0..6} because N = 5 (in S6) signed S7. H = 1 cites M's S7 to leave S5. B signs S5
// as well: S5 and S7 both complete. M's reason for S7 is about S6, not S5 - but M left S5 for S6 with a reason too, so M is excused.
const S5 = drawn.slice(0, 5), S6 = drawn.slice(0, 6), S7 = drawn.slice(0, 7);
const [M744, H744, B744, N744] = [drawn[0], drawn[1], drawn[4], drawn[5]];
const mLeft5 = { of: S5, seated: S6, member: B744, signature: sigOver(S6, B744), nested: null };
const mChain = { of: S6, seated: S7, member: N744, signature: sigOver(S7, N744), nested: null, prior: { signature: sigOver(S6, M744), justification: mLeft5 } };
const hViaM = { of: S5, seated: S7, member: M744, signature: sigOver(S7, M744), nested: mChain };
const byB5 = [2, 3].map((i) => ({ nodePubkey: drawn[i], justification: { of: S5, seated: S6, member: B744, signature: sigOver(S6, B744), nested: null } }));

test('kanban #744 (protocol 22): honest M on S5 -> S6 -> S7 and a Byzantine completing S5 - M is excused by its chain, the Byzantine named', () => {
  const a = cert22(S5);
  const b = cert22(S7, [{ nodePubkey: M744, justification: mChain }, { nodePubkey: H744, justification: hViaM }, ...byB5]);
  const vb = verifySeating(b, check22);
  assert.equal(vb.ok, true, vb.why);
  const e = seatingEquivocation(a, b, check22);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex), [toHex(B744)], 'the proof names the Byzantine alone');
  for (const k of [M744, H744, drawn[2], drawn[3]]) assert.ok(e.excused.some((x) => toHex(x) === toHex(k)), `${toHex(k).slice(0, 8)} excused`);
  assert.ok(e.signedTwice.some((x) => toHex(x.node) === toHex(B744) && x.certificate === 'a' && x.seated.map(toHex).join() === S6.map(toHex).join()), 'B signed S5 and S6');
  assert.equal(e.unnamed, false);
  // the excuse does not depend on which seating H cited, nor on M carrying its own chain in the certificate: H's nests it
  const bare = cert22(S7, [{ nodePubkey: H744, justification: hViaM }, ...byB5]);
  assert.deepEqual(seatingEquivocation(a, bare, check22).signers.map(toHex), [toHex(B744)], 'M\'s chain, nested in H\'s, excuses M');
  // and the proof S5 against M's signature over S7 alone does not stand: its chain runs S5 -> S6 -> S7
  const r = seatingSignedTwice(a, { node: M744, seated: S7, signature: sigOver(S7, M744), justification: mChain }, check22);
  assert.equal(r.ok, false); assert.match(r.why, /carries a justification/);
  assert.equal(seatingSignedTwice(a, { node: M744, seated: S7, signature: sigOver(S7, M744) }, check22).ok, true, 'with no chain presented it would');
  // the chain rides on the wire with M's last signature
  const back = decodeJustification(encodeJustification(mChain));
  assert.deepEqual([back.of.length, back.prior.justification.of.length, toHex(back.prior.justification.member)], [6, 5, toHex(B744)]);
});

test('kanban #744 (protocol 22): a justification carries at most 8 steps - one more is never encoded, read or counted', () => {
  // all of S, onto T: 1 and 2 cite each other's T, n deep under H = 0's
  const deep = (n, signer = drawn[0]) => { const m = signer === drawn[1] ? drawn[2] : drawn[1];
    return { of: S, seated: T, member: m, signature: sigOver(T, m), nested: n > 1 ? deep(n - 1, m) : null }; };
  const on = { roundId, role: 'game', drawn, slots: 7, verify, signer: drawn[0], onto: T };
  assert.equal(verifyJustification(deep(8), on).ok, true, 'eight stand');
  assert.match(verifyJustification(deep(9), on).why, /at most 8 steps/);
  assert.throws(() => encodeJustification(deep(9)), /at most 8 steps/);
  // nine on the wire: an outer step whose nested flag is set, ahead of the eight
  const outer = encodeJustification({ ...deep(1), nested: null }); outer[outer.length - 1] = 1;
  assert.throws(() => decodeJustification(Uint8Array.from([...outer, ...encodeJustification(deep(8, drawn[1]))])), /at most 8 steps/);
});

test('kanban #744 (protocol 22): a forged step - signed by a non-member of the seating it leaves - breaks the chain, and M is named', () => {
  const U = [0, 1, 2, 3, 4, 6].map((i) => drawn[i]), stranger = drawn[6];   // 6 is not in S5
  const forged = { ...mChain, prior: { signature: sigOver(S6, M744), justification: { of: S5, seated: U, member: stranger, signature: sigOver(U, stranger), nested: null } } };
  const on = { roundId, role: 'game', drawn, slots: 7, verify, signer: M744, onto: S7 };
  assert.match(verifyJustification(forged, on).why, /step before: the justification's member [0-9a-f]+ is not in the seating it says can never stand/);
  const a = cert22(S5);
  assert.equal(seatingSignedTwice(a, { node: M744, seated: S7, signature: sigOver(S7, M744), justification: forged }, check22).ok, true, 'S5 and S7 against M');
  // H cites M with the forged chain presented beside it: M is named with the Byzantine
  const b = cert22(S7, [{ nodePubkey: H744, justification: { ...hViaM, nested: null } }, ...byB5]);
  const e = seatingEquivocation(a, b, check22, [{ nodePubkey: M744, seated: S7, justification: forged }]);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex).sort(), [toHex(B744), toHex(M744)].sort());
  // the honest chain presented the same way excuses it
  assert.deepEqual(seatingEquivocation(a, b, check22, [{ nodePubkey: M744, seated: S7, justification: mChain }]).signers.map(toHex), [toHex(B744)]);
  // and a certificate carrying the forged one does not stand
  assert.match(verifySeating(cert22(S7, [{ nodePubkey: M744, justification: forged }]), check22).why, /justification does not stand/);
});
