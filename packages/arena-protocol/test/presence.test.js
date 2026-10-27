// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONLY NODES SEEN IN THE LAST 24 H ARE DRAWN, AND ABSENT ONLY WITH PROOF (§5A.3, protocol 22, kanban #727, the owner 2026-10-27). The
// testnet4 day of 2026-10-27 on the protocol's own draw: 28 bonded nodes, 20 of them stopped with their bonds still locked; a round
// draws 9 and needs 5 present. A node leaves the census only on threshold-signed seating certificates of 3 seatings of the 24 h (3
// different closes) that show it drawn - or left out already - and present at none of them. Every certificate here is signed for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { drawCommittee } from '../src/sortition.js';
import { censusRootOf } from '../src/census.js';
import { toHex, fromHex } from '../src/hash.js';
import { PRESENCE_VERSION, ABSENCE_PROOF_SEATINGS } from '../src/constants.js';
import { encodeSeatingCertificate, decodeSeatingCertificate, verifySeating, signSeating, signSeen, seatingId, seatingListsPresent } from '../src/seating.js';
import { absentFrom, withoutAbsent, absentImplied, checkAbsenceProof, provenSeating, presenceWindow, inWindow, dropsAbsent, PRESENCE_WINDOW_MS } from '../src/presence.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secretOf = (k) => b32(k);
const keyOf = new Map();
const key = (k) => { if (!keyOf.has(k)) keyOf.set(k, schnorr.getPublicKey(secretOf(k))); return keyOf.get(k); };
const hex = (k) => toHex(key(k));
const byHex = new Map();
const entry = (k) => { const txid = b32(k); txid[0] = 0x70; byHex.set(hex(k), k); return { txid, vout: 0, pubkey: key(k), bondSats: 100000n, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false, advertId: b32(0xad) }; };
const contract = { gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID, protocolVersion: PRESENCE_VERSION };
const DEAD = Array.from({ length: 20 }, (_, i) => i + 1);          // 11 installer nodes, 6 on the main macOS, t-1..t-3
const LIVE = Array.from({ length: 8 }, (_, i) => i + 21);
const census = [...DEAD, ...LIVE].map(entry);
const chainKeys = census.map((e) => toHex(e.pubkey));
const isLive = (h) => LIVE.some((k) => hex(k) === h);
const seed = (s, d) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; b[2] = 0x27; b[3] = d; return b; };
const T0 = 1793145600000n;                                          // the first census block's median time past (2026-10-28 00:00Z)
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const signBy = (h) => (m) => schnorr.sign(m, secretOf(byHex.get(h)));

/**
 * A 22 CERTIFICATE, signed for real: every seated node signs the seating and its SEEN (`present`, `leftOut`). `lists` overrides one
 * seated node's present list (by its key) - an honest node that held a PRESENT another did not.
 */
function certify({ roundId, role, seated, present, leftOut = [], lists = {}, signers = seated, seenBy = seated, seenSigner = (h) => signBy(h) }) {
  const rid = fromHex(roundId);
  const seatedKeys = seated.map(fromHex);
  const signatures = signers.map((h) => ({ nodePubkey: fromHex(h), signature: signSeating({ roundId: rid, role, seated: seatedKeys }, signBy(h)) }));
  const id = seatingId({ roundId: rid, role, seated: seatedKeys });
  const groups = new Map();
  for (const h of seenBy) {
    const p = lists[h] || present;
    const k = `${[...p].sort().join(',')}|${[...leftOut].sort().join(',')}`;
    if (!groups.has(k)) groups.set(k, { present: p, leftOut, signatures: [] });
    groups.get(k).signatures.push({ nodePubkey: fromHex(h), signature: signSeen({ roundId: rid, role, seating: id, present: p, leftOut }, seenSigner(h)) });
  }
  return encodeSeatingCertificate({ roundId: rid, role, seated: seatedKeys, signatures, seen: [...groups.values()] });
}

/**
 * One day of seatings on `entries`, a round every 15 min (Up/Down), both roles, as §5A.7 seats them: present = the live drawn (and a
 * returning node the census left out, when `back` names it), seated = the first 7 present if 5 or more. Answers the seatings with
 * their records; a certificate is signed only when a proof needs it (`certOf`).
 */
function day(entries, d, w, { back = [] } = {}) {
  const leftOut = absentImplied(census, entries);
  const out = [];
  for (let i = 0; i < 96; i++) {
    for (const role of ['game', 'settlement']) {
      const roundId = toHex(seed(1000 + i, d));
      const drawn = drawCommittee({ entries, contract, role, committeeSeed: seed(i * 2 + (role === 'game' ? 1 : 0), d) }).map((e) => toHex(e.pubkey));
      const present = [...drawn.filter(isLive), ...back.filter((h) => leftOut.includes(h))];
      const seated = drawn.filter((h) => present.includes(h)).slice(0, 7);
      out.push({ roundId, role, closeMs: w.fromMs + BigInt(i + 1) * 900000n, drawn, present, leftOut, seated: seated.length >= 5 ? seated : null });
    }
  }
  return out;
}
/** The seatings a seat or a client can hold proofs of: the certified ones. */
const proven = (seatings) => seatings.filter((s) => s.seated).map((s) => ({ ...s, present: [...new Set([...s.present, ...s.seated])] }));
/** What a checker has: its own draw of each seating, and the certificates (signed when first asked). */
function checker(seatings) {
  const by = new Map(seatings.map((s) => [`${s.roundId}:${s.role}`, s]));
  const certs = new Map();
  return {
    drawOf: (rid, role) => { const s = by.get(`${rid}:${role}`); return s ? { drawn: s.drawn, slots: 7, closeMs: s.closeMs } : null; },
    certOf: (rid, role) => {
      const k = `${rid}:${role}`;
      if (!certs.has(k)) { const s = by.get(k); certs.set(k, s && s.seated ? certify(s) : null); }
      return certs.get(k);
    },
  };
}

test('a 22 certificate names every node present at the close - the seated, a present reserve, a node coming back - and a certificate below 22 is as before, byte for byte', () => {
  const drawn = LIVE.map(hex).concat([hex(1)]);                     // 9 drawn: 8 live, 1 stopped
  const roundId = toHex(seed(7, 0));
  const seated = LIVE.slice(0, 7).map(hex);
  const reserve = hex(28), back = hex(9);                           // node 9: left out of the round's census, says PRESENT undrawn
  const cert = certify({ roundId, role: 'settlement', seated, present: [...LIVE.map(hex), back], leftOut: [back, hex(10)] });
  const v = verifySeating(cert, { roundId: fromHex(roundId), role: 'settlement', drawn: drawn.map(fromHex), slots: 7, verify, listsPresent: true });
  assert.equal(v.ok, true, v.why);
  assert.ok(v.present.includes(reserve), 'the present reserve is named, though not seated');
  assert.ok(v.present.includes(back), 'the node coming back is named');
  assert.ok(!v.present.includes(hex(1)), 'the stopped drawn node is not');
  assert.deepEqual(v.leftOut, [back, hex(10)].sort());
  // a seated node that held one more PRESENT than the others: present if ANY seated node lists it
  const one = certify({ roundId, role: 'settlement', seated, present: LIVE.map(hex), lists: { [seated[3]]: [...LIVE.map(hex), hex(1)] } });
  assert.ok(verifySeating(one, { roundId: fromHex(roundId), role: 'settlement', drawn: drawn.map(fromHex), slots: 7, verify, listsPresent: true }).present.includes(hex(1)));
  // BELOW 22: the certificate ends after its signatures, exactly the bytes it always had
  const rid = fromHex(roundId), seatedKeys = seated.map(fromHex);
  const signatures = seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeating({ roundId: rid, role: 'settlement', seated: seatedKeys }, signBy(h)) }));
  const old = encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: seatedKeys, signatures });
  assert.equal(old.length, 1 + 2 + 32 + 1 + 2 + 7 * 32 + 2 + 7 * 96, 'type, version, round, role, seated, signatures - nothing after');
  assert.equal(decodeSeatingCertificate(old).seen, null);
  const head = 1 + 2 + 32 + 1 + 2 + 7 * 32;
  assert.deepEqual([...cert.subarray(0, head)], [...old.subarray(0, head)], 'a 22 certificate begins with the same seating body');
  assert.equal(toHex(seatingId(decodeSeatingCertificate(cert))), toHex(seatingId(decodeSeatingCertificate(old))), 'and has the same seating id: equivocation is read as before');
  const check = { roundId: rid, role: 'settlement', drawn: drawn.map(fromHex), slots: 7, verify };
  assert.equal(verifySeating(old, { ...check, listsPresent: false }).ok, true);
  assert.equal(verifySeating(old, check).ok, true, 'a caller that does not say the version reads it as before');
  assert.match(verifySeating(old, { ...check, listsPresent: true }).why, /22 round and names nobody present/);
  assert.match(verifySeating(cert, { ...check, listsPresent: false }).why, /below protocol 22 and carries a present list/);
  assert.equal(seatingListsPresent({ protocolVersion: 21 }), false);
  assert.equal(seatingListsPresent({ protocolVersion: 22 }), true);
  // every seated node signs who was present; nobody else does; a forged signature does not stand
  assert.match(verifySeating(certify({ roundId, role: 'settlement', seated, present: LIVE.map(hex), seenBy: seated.slice(1) }), { ...check, listsPresent: true }).why, /did not sign who was present/);
  assert.match(verifySeating(certify({ roundId, role: 'settlement', seated, present: LIVE.map(hex), seenBy: [...seated, reserve] }), { ...check, listsPresent: true }).why, /is not seated in it/);
  assert.match(verifySeating(certify({ roundId, role: 'settlement', seated, present: LIVE.map(hex), seenSigner: (h) => (h === seated[0] ? signBy(seated[1]) : signBy(h)) }), { ...check, listsPresent: true }).why, /signature on who was present does not verify/);
  assert.match(verifySeating(certify({ roundId, role: 'settlement', seated, present: LIVE.map(hex), leftOut: [hex(1)] }), { ...check, listsPresent: true }).why, /left out a node the round drew/);
});

// ONLY A SEATED ROUND PROVES ANYTHING: on the 10-27 day almost no round is seated, so day 0 proves little; every node it proves absent
// lifts the next day's seated share, and the stopped nodes are all out within days - and stay out, each left-out seating proving it again.
test('the 10-27 shape: the stopped nodes are proven absent by certificates within days, no live node ever is, and from then every round is seated, 96 of 96', () => {
  let entries = census;
  const facts = [];
  let T = T0, allOutFrom = null;
  for (let d = 0; d < 6; d++) {
    const w = presenceWindow(T);
    const seatings = day(entries, d, w);
    const seatedRounds = seatings.filter((s) => s.role === 'settlement' && s.seated).length;
    const claims = absentFrom({ seatings: proven(seatings), census: chainKeys, window: w });
    assert.ok(claims.every((c) => !isLive(c.node)), `day ${d}: no live node is proven absent`);
    assert.ok(claims.every((c) => c.proofs.length === ABSENCE_PROOF_SEATINGS), 'each absence names 3 seatings');
    // the proofs stand at every checker that draws the day itself - a seat, a client
    const ch = checker(seatings);
    assert.deepEqual(checkAbsenceProof(claims, { census: chainKeys, window: w, verify, ...ch }), { ok: true }, `day ${d}: the claim stands`);
    facts.push(`day ${d}: census ${entries.length}, seated ${seatedRounds}/96, proven absent ${claims.length}`);
    if (d === 0) assert.ok(seatedRounds < 48, 'the day before the rule seats fewer than half its rounds');
    if (allOutFrom !== null) {
      assert.equal(seatedRounds, 96, `day ${d}: drawn from a census of live nodes only, every round is seated`);
      assert.equal(claims.length, DEAD.length, `day ${d}: the ${DEAD.length} stopped nodes stay proven absent - left out, and present at none`);
    }
    if (allOutFrom === null && claims.length === DEAD.length) allOutFrom = d + 1;
    entries = withoutAbsent(census, claims);
    T += PRESENCE_WINDOW_MS;
  }
  console.log(`  FACTS: 28 bonded, 20 stopped; ${facts.join('; ')}`);
  assert.ok(allOutFrom !== null && allOutFrom <= 3, `every stopped node is out of the census by day 3 (from day ${allOutFrom})`);
});

test('DoS: a live node flooded at 2 of its seatings stays in; at 3 different closes it is out; never drawn, or present once, stays in', () => {
  const w = presenceWindow(T0);
  const target = hex(21), others = LIVE.slice(1).map(hex);
  // seatings that each drew `target` and 6 live others, at closes an hour apart; `missed` of them while it was flooded
  const seating = (i, missed, role = 'settlement', closeMs = w.toMs - BigInt(i) * 3600000n) => {
    const drawn = [target, ...others, hex(1), hex(2)];
    const present = missed ? others : [target, ...others];
    return { roundId: toHex(seed(500 + i, 0)), role, closeMs, drawn, present, leftOut: [], seated: present.slice(0, 7) };
  };
  const out = (list) => absentFrom({ seatings: list, census: [target, hex(1)], window: w }).map((c) => c.node);
  assert.deepEqual(out([seating(1, true), seating(2, true)]), [], 'flooded at its only 2 seatings: kept (and the stopped node 1, missed at 2, too)');
  assert.deepEqual(out([seating(1, true), seating(2, true), seating(3, false)]), [hex(1)], 'flooded at 2, present at a third: kept; node 1, missed at 3: out');
  assert.deepEqual(out([seating(1, true), seating(2, true), seating(3, true)]).sort(), [target, hex(1)].sort(), 'missed at 3 different closes and present at none: absent');
  // the two roles of one round close together: a blackout there counts once
  assert.deepEqual(out([seating(1, true), seating(1, true, 'game'), seating(2, true)]), [], 'three seatings at two closes: kept');
  // the checker holds to the same: a claim naming it on 2 closes does not stand
  const two = [seating(1, true), seating(1, true, 'game'), seating(2, true)];
  const ch = { drawOf: (rid, role) => { const x = two.find((q) => q.roundId === rid && q.role === role); return x ? { drawn: x.drawn, slots: 7, closeMs: x.closeMs } : null; },
    certOf: (rid, role) => certify(two.find((q) => q.roundId === rid && q.role === role)) };
  assert.equal(checkAbsenceProof([{ node: target, proofs: two.map((q) => ({ roundId: q.roundId, role: q.role })) }], { census: [target], window: w, verify, ...ch }).proof, 'too-few');
  // never drawn: kept
  assert.deepEqual(absentFrom({ seatings: [seating(1, true), seating(2, true), seating(3, true)], census: [hex(40)], window: w }), []);
  // a seating outside the window counts for nothing
  assert.deepEqual(out([seating(1, true, 'settlement', w.toMs + 1n), seating(2, true, 'settlement', w.fromMs), seating(3, true)]), []);
  assert.equal(inWindow(w, w.fromMs + 1n), true);
});

test('a claim naming an honest node does not stand: present in a certificate, proven at 2 seatings only, a forged or an under-threshold certificate, a seating that did not draw it', () => {
  const w = presenceWindow(T0);
  const seatings = day(census, 0, w);
  const ch = checker(seatings);
  const claims = absentFrom({ seatings: proven(seatings), census: chainKeys, window: w });
  const victim = claims[0];
  const at = (p) => seatings.find((s) => s.roundId === p.roundId && s.role === p.role);
  const run = (cl, over = {}) => checkAbsenceProof(cl, { census: chainKeys, window: w, verify, ...ch, ...over });
  assert.deepEqual(run(claims), { ok: true });
  // 1. present in a certificate: one seated node of a named seating listed it
  const s0 = at(victim.proofs[0]);
  const listed = certify({ ...s0, lists: { [s0.seated[2]]: [...s0.present, victim.node] } });
  let r = run([victim], { certOf: (rid, role) => (rid === s0.roundId && role === s0.role ? listed : ch.certOf(rid, role)) });
  assert.equal(r.ok, false); assert.equal(r.proof, 'present');
  // a seat holding a window certificate (or a PRESENT) of it refuses too, whatever the claim names
  assert.equal(run([victim], { seen: [victim.node] }).proof, 'seen');
  // 2. proven at 2 seatings only
  r = run([{ node: victim.node, proofs: victim.proofs.slice(0, 2) }]);
  assert.equal(r.proof, 'too-few'); assert.match(r.why, /2 missed seating close\(s\); it takes 3/);
  // the same seating twice is not two
  assert.equal(run([{ node: victim.node, proofs: [victim.proofs[0], victim.proofs[0], victim.proofs[1]] }]).proof, 'too-few');
  // 3. a forged certificate: signed by keys that are not the seated
  const forged = certify({ ...s0, seenSigner: () => signBy(hex(1)) });
  assert.equal(run([victim], { certOf: (rid, role) => (rid === s0.roundId ? forged : ch.certOf(rid, role)) }).proof, 'certificate');
  // under threshold: 4 seated of a 7-seat round
  const four = certify({ ...s0, seated: s0.seated.slice(0, 4) });
  r = run([victim], { certOf: (rid, role) => (rid === s0.roundId ? four : ch.certOf(rid, role)) });
  assert.equal(r.proof, 'certificate'); assert.match(r.why, /fewer than the 5/);
  // no certificate carried, and none held
  assert.equal(run([victim], { certOf: () => null }).proof, 'certificate');
  // 4. a live node named absent at seatings that never drew it (certificates real, of other seatings)
  const live = hex(21);
  const notDrawn = proven(seatings).filter((s) => !s.drawn.includes(live) && !s.present.includes(live)).slice(0, 3);
  r = run([{ node: live, proofs: notDrawn.map((s) => ({ roundId: s.roundId, role: s.role })) }]);
  assert.equal(r.proof, 'not-missed');
  // a seating this checker cannot draw yet: not refused for good, only not yet
  assert.equal(run(claims, { drawOf: () => null }).notYet, true);
  // shape: sorted, once each, in the chain census
  assert.match(run([victim, victim]).why, /not sorted/);
  assert.match(run([{ node: hex(77), proofs: victim.proofs }]).why, /not in the chain census/);
  // the proven seating, as a record
  const p = provenSeating(ch.certOf(s0.roundId, s0.role), { roundId: s0.roundId, role: s0.role, drawn: s0.drawn, slots: 7, closeMs: s0.closeMs, verify });
  assert.equal(p.ok, true); assert.deepEqual(p.seating.seated, s0.seated);
});

test('the root commits to the census less the absent, and the absent are recovered from the root\'s entries', () => {
  const w = presenceWindow(T0);
  const claims = absentFrom({ seatings: proven(day(census, 0, w)), census: chainKeys, window: w });
  const at = { censusHeight: 10, censusConfirmations: 1 };
  const full = censusRootOf(census, at), less = censusRootOf(withoutAbsent(census, claims), at);
  assert.notEqual(toHex(full.root), toHex(less.root));
  assert.deepEqual(absentImplied(census, less.entries), claims.map((c) => c.node), 'any seat with the chain and the entries names the same absent');
  const second = { ...entry(claims.length ? byHex.get(claims[0].node) : 1), txid: b32(0x99), vout: 1 };
  assert.equal(withoutAbsent([...census, second], claims).some((e) => toHex(e.pubkey) === toHex(second.pubkey)), !claims.length, 'every output of an absent node goes with it');
  assert.equal(dropsAbsent({ protocolVersion: 21 }), false, 'below 22 nothing is left out');
  assert.equal(dropsAbsent({ protocolVersion: 22 }), true);
});
