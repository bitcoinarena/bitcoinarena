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
  encodeJustification, decodeJustification, signSeatingBound, seatingSignedId, justificationHash } from '../src/seating.js';
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
// From 22 every SEATING signature binds the hash of its justification (kanban #746): `sigBound` signs that way, `step` is a step
// citing the member's signature (a first one unless `j` is given) with the hash that signature binds.
const S = [0, 1, 2, 4, 5].map((i) => drawn[i]), T = drawn.slice(0, 7), B = drawn[1];
const nodeOf = (k) => nodes.find((n) => n.pubkey === k);
const sigOver = (seated, k) => signSeating({ roundId, role: 'game', seated }, sign(nodeOf(k)));
const sigBound = (seated, k, j = null) => signSeatingBound({ roundId, role: 'game', seated }, sign(nodeOf(k)), j);
const hashOf = (j) => justificationHash(j ? encodeJustification(j) : null);
const step = (of, seated, member, j = null) => ({ of, seated, member, signature: sigBound(seated, member, j), bound: hashOf(j) });
// a 22 certificate: every seated node also signs who it held a PRESENT of (here: the seated), and its SEATING signature binds the
// justification the certificate carries for it (none: the empty string's hash) unless `sigs` gives it
const cert22 = (seated, justifications = null, sigs = new Map()) => encodeSeatingCertificate({ roundId, role: 'game', seated, justifications,
  signatures: seated.map((k) => ({ nodePubkey: k, signature: sigs.get(k) || sigBound(seated, k, ((justifications || []).find((x) => x.nodePubkey === k) || {}).justification || null) })),
  seen: [{ present: seated, leftOut: [], signatures: seated.map((k) => ({ nodePubkey: k,
    signature: signSeen({ roundId, role: 'game', seating: seatingId({ roundId, role: 'game', seated }), present: seated, leftOut: [] }, sign(nodeOf(k))) })) }] });
const byB = sigBound(T, B);
const why = { of: S, seated: T, member: B, signature: byB, bound: justificationHash(null) };
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
  assert.deepEqual(e.excused.map(toHex).sort(), honestLeft.map(toHex).sort(), 'each honest seat\'s second signature binds B\'s T: excused');
  assert.ok(e.signedTwice.some((x) => toHex(x.node) === toHex(B) && x.certificate === 'a' && x.seated.map(toHex).join() === T.map(toHex).join()), 'T and S: B\'s own equivocation');
  // the same proof, T against S, on its own: B signed the certificate of S and T, with no reason
  assert.equal(seatingSignedTwice(a, { node: B, seated: T, signature: byB }, check22).ok, true);
  // and never against an honest seat: H's signature over T binds the justification
  const H = drawn[0];
  const r = seatingSignedTwice(a, { node: H, seated: T, signature: sigBound(T, H, why), justification: why }, check22);
  assert.equal(r.ok, false); assert.match(r.why, /carries a justification/);
  // the certificates' order does not matter
  const e2 = seatingEquivocation(b, a, check22);
  assert.deepEqual([e2.signers.map(toHex), e2.signedTwice[0].certificate], [[toHex(B)], 'b']);
});

test('kanban #738 (protocol 22): a member whose own T was a second signature is excused by the justification its own signature binds - the chain ends at B', () => {
  // M = 2 left S for T because B signed T; H = 0 left S because M signed T, citing M's signature and the hash it binds
  const M = drawn[2], byM = sigBound(T, M, why);
  const viaM = { of: S, seated: T, member: M, signature: byM, bound: hashOf(why) };
  const ju = [{ nodePubkey: drawn[0], justification: viaM }, ...[2, 4, 5].map((i) => ({ nodePubkey: drawn[i], justification: why }))];
  const b = cert22(T, ju, new Map([[B, byB], [M, byM]]));
  assert.equal(verifySeating(b, check22).ok, true);
  const e = seatingEquivocation(cert22(S), b, check22);
  assert.deepEqual(e.signers.map(toHex), [toHex(B)]);
  assert.ok(e.excused.some((k) => toHex(k) === toHex(M)));
  // M's justification is bound in its signature: a certificate that leaves it out does not stand
  const bare = cert22(T, [{ nodePubkey: drawn[0], justification: viaM }, ...[4, 5].map((i) => ({ nodePubkey: drawn[i], justification: why }))], new Map([[B, byB], [M, byM]]));
  assert.match(verifySeating(bare, check22).why, /does not verify with the justification it carries/);
  // and a member that signed T first, with no reason, is the one proved against when H cites it
  const firstM = sigBound(T, M);
  const plain = cert22(T, [{ nodePubkey: drawn[0], justification: { ...viaM, signature: firstM, bound: hashOf(null) } }, ...[4, 5].map((i) => ({ nodePubkey: drawn[i], justification: why }))], new Map([[B, byB], [M, firstM]]));
  assert.deepEqual(seatingEquivocation(cert22(S), plain, check22).signers.map(toHex).sort(), [toHex(B), toHex(M)].sort());
});

test('kanban #738 (protocol 22): a forged justification stands for nothing - not by a member of S, a T before S, a bad signature, an S\' not after S', () => {
  const stranger = drawn[8], H = drawn[0];
  const on = { roundId, role: 'game', drawn, slots: 7, verify, signer: H, onto: T };
  assert.equal(verifyJustification(why, on).ok, true);
  const T8 = [0, 1, 2, 3, 4, 5, 8].map((i) => drawn[i]);
  assert.match(verifyJustification(step(S, T8, stranger), on).why, /not in the seating it says can never stand/);
  const before = [0, 1, 2, 4].map((i) => drawn[i]);                 // fewer seated: it comes before S
  assert.match(verifyJustification(step(S, before, B), on).why, /comes before the seating left/);
  assert.match(verifyJustification({ ...why, signature: sigBound(T, drawn[3]) }, on).why, /signature is not/);
  assert.match(verifyJustification(why, { ...on, onto: [0, 1, 2, 4, 6].map((i) => drawn[i]) }).why, /does not come after/);
  assert.match(verifyJustification(step(S, T, H), on).why, /names the signer itself/);
  // below 22 a signature binds nothing: B's plain signature over T is no step
  assert.match(verifyJustification({ ...why, signature: sigOver(T, B) }, on).why, /signature is not/);
  // a certificate that carries a forged one does not stand
  const forged = cert22(T, [{ nodePubkey: H, justification: { ...why, signature: sigBound(T, drawn[3]) } }]);
  assert.match(verifySeating(forged, check22).why, /justification does not stand/);
  // the wire form round-trips: 32 bytes of the hash the member's signature binds after its signature, then the flags
  const bytes = encodeJustification(why);
  assert.deepEqual(encodeJustification(decodeJustification(bytes)), bytes);
  assert.equal(toHex(decodeJustification(bytes).bound), toHex(justificationHash(null)));
  assert.equal(bytes.length, 2 + 5 * 32 + 2 + 7 * 32 + 32 + 64 + 32 + 1);
  // the nested form is gone (kanban #746): a flag beyond bit 0 is refused
  const flagged = Uint8Array.from(bytes); flagged[flagged.length - 1] = 2;
  assert.throws(() => decodeJustification(flagged), /flags are bit 0 alone/);
});

test('kanban #738: below protocol 22 nothing carries a justification - the certificate and its signatures are byte for byte as before', () => {
  const seated = drawn.slice(0, 7);
  const sigs = seated.map((k) => ({ nodePubkey: k, signature: sigOver(seated, k) }));
  assert.deepEqual(encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs, justifications: [] }),
    encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs }));
  assert.throws(() => encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs, justifications: [{ nodePubkey: drawn[0], justification: why }] }), /only with who was present/);
  assert.equal(decodeSeatingCertificate(encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs })).justifications, null);
  // kanban #746: below 22 a SEATING signature is over the seating id alone; one binding a hash does not stand there, and a plain one
  // does not stand in a 22 certificate
  const plain = encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: sigs });
  assert.equal(verifySeating(plain, { ...check, listsPresent: false }).ok, true);
  const boundSigs = seated.map((k) => ({ nodePubkey: k, signature: sigBound(seated, k) }));
  assert.match(verifySeating(encodeSeatingCertificate({ roundId, role: 'game', seated, signatures: boundSigs }), { ...check, listsPresent: false }).why, /signature on that seating does not verify/);
  assert.match(verifySeating(cert22(seated, null, new Map(sigs.map((x) => [x.nodePubkey, x.signature]))), check22).why, /does not verify with the justification it carries/);
  // the bound id is its own tag over the seating id and the hash: never the seating id
  const s = { roundId, role: 'game', seated };
  assert.notEqual(toHex(seatingSignedId(s, justificationHash(null))), toHex(seatingId(s)));
});

// A CHAIN OF DEPARTURES EXCUSES (kanban #744, RULED 2026-10-28). Honest M = 0 signs S5 = {0..4}, then S6 = {0..5} because the
// Byzantine B = 4 (in S5) signed S6, then S7 = {0..6} because N = 5 (in S6) signed S7. H = 1 cites M's S7 to leave S5. B signs S5
// as well: S5 and S7 both complete. M's reason for S7 is about S6, not S5 - but M left S5 for S6 with a reason too, so M is excused.
// From 22 each of M's signatures binds its justification (kanban #746): over S6 the step S5 -> S6, over S7 the step S6 -> S7 with
// its signature over S6 as the step before.
const S5 = drawn.slice(0, 5), S6 = drawn.slice(0, 6), S7 = drawn.slice(0, 7);
const [M744, H744, B744, N744] = [drawn[0], drawn[1], drawn[4], drawn[5]];
const mLeft5 = step(S5, S6, B744);
const mChain = { ...step(S6, S7, N744), prior: { signature: sigBound(S6, M744, mLeft5), justification: mLeft5 } };
const hViaM = step(S5, S7, M744, mChain);
const byB5 = [2, 3].map((i) => ({ nodePubkey: drawn[i], justification: step(S5, S6, B744) }));

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
  assert.deepEqual(e.doubleSigned, [], 'nobody signed one seating twice');
  assert.equal(e.unnamed, false);
  // the excuse does not depend on which seating H cited: H citing B's S6 instead leaves M excused all the same
  const viaB = cert22(S7, [{ nodePubkey: M744, justification: mChain }, { nodePubkey: H744, justification: step(S5, S6, B744) }, ...byB5]);
  assert.deepEqual(seatingEquivocation(a, viaB, check22).signers.map(toHex), [toHex(B744)]);
  // M's chain is bound in its signature over S7: a certificate that leaves it out does not stand
  const bare = cert22(S7, [{ nodePubkey: H744, justification: hViaM }, ...byB5], new Map([[M744, sigBound(S7, M744, mChain)]]));
  assert.match(verifySeating(bare, check22).why, /does not verify with the justification it carries/);
  // and the proof S5 against M's signature over S7 alone does not stand: its chain runs S5 -> S6 -> S7
  const r = seatingSignedTwice(a, { node: M744, seated: S7, signature: sigBound(S7, M744, mChain), justification: mChain }, check22);
  assert.equal(r.ok, false); assert.match(r.why, /carries a justification/);
  assert.equal(seatingSignedTwice(a, { node: M744, seated: S7, signature: sigBound(S7, M744, mChain), justificationHash: hashOf(mChain) }, check22).ok, true, 'with no chain presented it would');
  // the chain rides on the wire with M's last signature
  const back = decodeJustification(encodeJustification(mChain));
  assert.deepEqual([back.of.length, back.prior.justification.of.length, toHex(back.prior.justification.member)], [6, 5, toHex(B744)]);
});

// S0 -> S1 -> ... of node 0, strictly increasing: {0, 8}, {0, 7}, ..., {0, 1}, {0, 1, 2}, {0, 1, 2, 3}; each step a member of the
// seating left (the other node) signing that seating with one node more
const ladder = [[0, 8], [0, 7], [0, 6], [0, 5], [0, 4], [0, 3], [0, 2], [0, 1], [0, 1, 2], [0, 1, 2, 3]].map((idx) => idx.map((i) => drawn[i]));
const rungStep = (i) => { const of = ladder[i], m = of[1];
  const extra = drawn.find((k) => !of.includes(k)), seated = drawn.filter((k) => of.includes(k) || k === extra);
  return step(of, seated, m); };
const chainOf = (n) => { let j = null; for (let i = 0; i < n; i++) j = { ...rungStep(i), ...(j ? { prior: { signature: sigBound(ladder[i], drawn[0], j), justification: j } } : {}) }; return j; };

test('kanban #744 (protocol 22): a justification carries at most 8 steps - one more is never encoded, read or counted', () => {
  const on = (n) => ({ roundId, role: 'game', drawn, slots: 7, verify, signer: drawn[0], onto: ladder[n] });
  const j7 = chainOf(7);
  assert.equal(verifyJustification(j7, on(7)).ok, true, 'seven stand');
  // the eighth step's signature binds the seven before it, the ninth's the eight
  const j8 = chainOf(8);
  assert.equal(verifyJustification(j8, on(8)).ok, true, 'eight stand');
  const j9 = chainOf(9);
  assert.match(verifyJustification(j9, on(9)).why, /at most 8 steps/);
  assert.throws(() => encodeJustification(j9), /at most 8 steps/);
  // nine on the wire: an outer step whose prior flag is set, ahead of the eight
  const outer = encodeJustification(rungStep(8)); outer[outer.length - 1] = 1;
  assert.throws(() => decodeJustification(Uint8Array.from([...outer, ...sigBound(ladder[8], drawn[0], j8), ...encodeJustification(j8)])), /at most 8 steps/);
});

test('kanban #744 (protocol 22): a forged step - signed by a non-member of the seating it leaves - breaks the chain, and M is named', () => {
  const U = [0, 1, 2, 3, 4, 6].map((i) => drawn[i]), stranger = drawn[6];   // 6 is not in S5
  const left = step(S5, U, stranger);
  const forged = { ...mChain, prior: { signature: sigBound(S6, M744, left), justification: left } };
  const on = { roundId, role: 'game', drawn, slots: 7, verify, signer: M744, onto: S7 };
  assert.match(verifyJustification(forged, on).why, /step before: the justification's member [0-9a-f]+ is not in the seating it says can never stand/);
  const a = cert22(S5);
  assert.equal(seatingSignedTwice(a, { node: M744, seated: S7, signature: sigBound(S7, M744, forged), justification: forged }, check22).ok, true, 'S5 and S7 against M');
  // the honest chain, presented the same way, excuses it
  assert.equal(seatingSignedTwice(a, { node: M744, seated: S7, signature: sigBound(S7, M744, mChain), justification: mChain }, check22).ok, false);
  // a certificate carrying the forged one does not stand, so a forged chain never reaches a judge in one
  assert.match(verifySeating(cert22(S7, [{ nodePubkey: M744, justification: forged }]), check22).why, /justification does not stand/);
  // H cites M's signature over S7 binding the forged chain, presented beside the certificates: M is named with the Byzantine
  const b = cert22(S7, [{ nodePubkey: H744, justification: step(S5, S7, M744, forged) }, ...byB5], new Map([[M744, sigBound(S7, M744)]]));
  const e = seatingEquivocation(a, b, check22, [{ nodePubkey: M744, seated: S7, signature: sigBound(S7, M744, forged), justification: forged }]);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex).sort(), [toHex(B744), toHex(M744)].sort());
});

// A JUSTIFICATION IS BOUND IN THE SIGNATURE IT EXCUSES (kanban #746, RULED 2026-10-28, option B). The #746 sequence on S = X and T:
// 1. B signs T first, with no reason: its signature binds the empty string's hash. 2. H = 0 leaves X and signs T bound to B's T.
// 3. B signs X too, and X completes. 4. B wants a chain X -> T.
test('kanban #746 (protocol 22): B signed T first, unjustified - B is named, H excused; a justification B attaches afterwards is no step', () => {
  const H = drawn[0];
  const a = cert22(S);                                                                   // X, completed with B's signature
  const b = cert22(T, honestLeft.map((k) => ({ nodePubkey: k, justification: why })), new Map([[B, byB]]));
  // what B would hang on its T: a step citing H's signature over T, a valid step on its own
  const hT = sigBound(T, H, why);
  const jB = { of: S, seated: T, member: H, signature: hT, bound: hashOf(why) };
  assert.equal(verifyJustification(jB, { roundId, role: 'game', drawn, slots: 7, verify, signer: B, onto: T }).ok, true, 'the step stands on its own');
  // presented beside B's signature over T, which binds the empty string's hash: not a step
  for (const presented of [[], [{ nodePubkey: B, seated: T, signature: byB, justification: jB }]]) {
    const e = seatingEquivocation(a, b, check22, presented);
    assert.equal(e.ok, true, e.why);
    assert.deepEqual(e.signers.map(toHex), [toHex(B)], 'B named');
    assert.ok(e.excused.some((k) => toHex(k) === toHex(H)), 'H excused');
    assert.equal(e.unnamed, false);
  }
  assert.equal(seatingSignedTwice(a, { node: B, seated: T, signature: byB, justification: jB }, check22).ok, false, 'attached afterwards: the signature does not bind it');
  assert.equal(seatingSignedTwice(a, { node: B, seated: T, signature: byB }, check22).ok, true, 'the signature as made: B named');
  // in a certificate: B's signature over T with jB attached does not verify, and the certificate does not stand
  const attached = cert22(T, [...honestLeft.map((k) => ({ nodePubkey: k, justification: why })), { nodePubkey: B, justification: jB }], new Map([[B, byB]]));
  assert.match(verifySeating(attached, check22).why, /seated node [0-9a-f]+'s signature on that seating does not verify with the justification it carries/);
});

test('kanban #746 (protocol 22): B re-signs T bound to H\'s T - two signatures over one seating, B named outright, H excused', () => {
  const H = drawn[0];
  const a = cert22(S);
  const hT = sigBound(T, H, why);
  const jB = { of: S, seated: T, member: H, signature: hT, bound: hashOf(why) };
  const byB2 = sigBound(T, B, jB);
  // the certificate of T with B's second signature over it and its justification: it stands - every signature binds what it carries
  const b = cert22(T, [...honestLeft.map((k) => ({ nodePubkey: k, justification: why })), { nodePubkey: B, justification: jB }], new Map([[B, byB2], [H, hT]]));
  const vb = verifySeating(b, check22);
  assert.equal(vb.ok, true, vb.why);
  // B's chain X -> T is valid on its own, but its first signature over T sits inside H's justification: two over one seating
  const e = seatingEquivocation(a, b, check22);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex), [toHex(B)], 'B named');
  assert.ok(!e.excused.some((k) => toHex(k) === toHex(B)), 'with no excuse');
  assert.ok(e.excused.some((k) => toHex(k) === toHex(H)), 'H excused');
  assert.equal(e.doubleSigned.length, 1);
  assert.deepEqual([toHex(e.doubleSigned[0].node), e.doubleSigned[0].seated.map(toHex).join()], [toHex(B), T.map(toHex).join()]);
  assert.deepEqual(e.doubleSigned[0].signatures.map((x) => toHex(x.justificationHash)).sort(), [toHex(justificationHash(null)), toHex(hashOf(jB))].sort());
  // and each of the two proves it on its own against the certificate of T
  const r = seatingSignedTwice(b, { node: B, seated: T, signature: byB }, check22);
  assert.deepEqual([r.ok, r.double], [true, true], r.why);
  // against the certificate of T holding B's first signature: its second, bound to jB, proves it; the same hash again does not
  const clean = cert22(T, honestLeft.map((k) => ({ nodePubkey: k, justification: why })), new Map([[B, byB]]));
  const r2 = seatingSignedTwice(clean, { node: B, seated: T, signature: byB2, justification: jB }, check22);
  assert.deepEqual([r2.ok, r2.double], [true, true], r2.why);
  assert.match(seatingSignedTwice(clean, { node: B, seated: T, signature: sigBound(T, B) }, check22).why, /signed once/);
});

test('kanban #746 (protocol 22): two signatures by one member over one seating name it, with no excuse - even an otherwise valid chain', () => {
  // M of the #744 run, chain S5 -> S6 -> S7 and excused by it - but it also signed S7 a second time with no justification
  const a = cert22(S5);
  const b = cert22(S7, [{ nodePubkey: M744, justification: mChain }, { nodePubkey: H744, justification: hViaM }, ...byB5]);
  const second = sigBound(S7, M744);
  const e = seatingEquivocation(a, b, check22, [{ nodePubkey: M744, seated: S7, signature: second }]);
  assert.equal(e.ok, true, e.why);
  assert.deepEqual(e.signers.map(toHex).sort(), [toHex(B744), toHex(M744)].sort(), 'M named beside B');
  assert.ok(!e.excused.some((k) => toHex(k) === toHex(M744)), 'its chain does not excuse it');
  assert.deepEqual(e.doubleSigned.map((d) => toHex(d.node)), [toHex(M744)]);
  const r = seatingSignedTwice(b, { node: M744, seated: S7, signature: second }, check22);
  assert.deepEqual([r.ok, r.double], [true, true], r.why);
  // the same signature again (the same hash) is one signature, not two
  const once = seatingEquivocation(a, b, check22, [{ nodePubkey: M744, seated: S7, signature: sigBound(S7, M744, mChain), justification: mChain }]);
  assert.deepEqual(once.signers.map(toHex), [toHex(B744)]);
  assert.deepEqual(once.doubleSigned, []);
  // below 22 nothing is signed twice over one seating: the certified seating is no second one
  const seated = drawn.slice(0, 7);
  assert.match(seatingSignedTwice(cert(seated), { node: drawn[0], seated, signature: sigOver(seated, drawn[0]) }, check).why, /not a second one/);
});
