// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESERVE SEATS (multiplayer_p2p.md §5A.7, RULED 2026-09-28).
//
// A node drawn up to 72 h ahead may be offline when its round comes, so each role draws more nodes than it seats
// (sortition.js drawCommittee: 9 for 7 seats) and seats the ones that show up:
//
//   present = drawn nodes that signed PRESENT(round_id, role, node_pubkey) before seating_close = start_time - 120 s
//   seated  = the first min(slots, |present|) present nodes in score order
//   a round opens for entries iff |seated| >= threshold
//
// The seated nodes sign SEATING(round_id, role, seated list); a seating is valid only with the signature of EVERY node it
// seats, and each node signs at most one seating per round and role that can still stand. Two valid seatings for one round
// and role always share a signer (2 x threshold > drawn), so two certificates are proof of equivocation by that signer: the
// round is void (§13C) and the signer's bond is slashable (§5A.3B).
//
// A SECOND SIGNATURE ONLY AFTER A MEMBER OF THE FIRST SIGNED ANOTHER (kanban #738, measured 2026-10-27 23:30Z: one overloaded seat
// signed the seating of 5 it held at the close, six signed the seating of 7, and no certificate formed). Seatings are ordered: S
// comes before T when T seats at least as many and its i-th seated ranks no lower in the draw than S's i-th, for every i of S.
// A node that signed S, holding no certificate, signs S' only when a member of S other than itself signed a seating that does
// not come before S, S' is the seating of the PRESENTs it holds now and comes after S, it is in S', and another node signed S'
// already (arena-node seating-agent.js resign). An honest node's signatures then come one after another in that order, the
// seating it left never completes, and two certificates still prove equivocation only by a node that broke this rule.
//
// NO RULE MAY EVER SLASH AN HONEST SEAT (kanban #738, RULED 2026-10-28, protocol 22). A Byzantine member B of S signs T to kill
// S, lets an honest H move on to S', then signs S as well: if S and S' both complete, the two share H. So from 22 a second
// seating signature carries its justification - B's signed seating T, which shows S can never stand (signed by a member of S,
// valid against the draw, not before S) - and a seating equivocation proof against a member is invalid where that member's
// second signature carries a valid justification. B is still caught: T and S are an equivocation of their own
// (seatingEquivocation `signedTwice`, seatingSignedTwice). Below 22 nothing carries one, byte for byte as before.
//
// A client enters a round only with a certificate it checked against the draw
// it computes itself (client-committee.js). The round contract is unchanged (2026-10-11, decision A): it names the
// round; who serves it is this certificate.
//
// FROM PROTOCOL 22 THE CERTIFICATE ALSO SAYS WHO WAS PRESENT (§5A.3, kanban #727, the owner 2026-10-27). A node may be left out of a
// census as absent only with proof, and the proof is this certificate: besides its SEATING signature, every seated node signs a
// SEEN over that seating - every node it held a valid PRESENT of at the seating close (drawn, or one the round's census left out as
// absent coming back) and the nodes the round's census left out as absent. The certificate carries them after its signatures, one
// group per distinct list. A node is present at the seating if ANY seated node lists it, so to hide an honest node's PRESENT every
// seated node must lie. A PRESENT that reaches the seated after the close is in no list: for the proof that seating is missed. The
// SEATING body, its id and the equivocation rule are untouched, and a certificate below 22 carries no SEEN - byte for byte as before.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_PRESENT, TYPE_SEATING, TYPE_SEATING_SEEN, PROTOCOL_VERSION, PRESENCE_VERSION, speaksVersion } from './constants.js';

/** seating_close is this long before the round's start: round i+1 is seated before round i (90 s earlier) starts. */
export const SEATING_LEAD_MS = 120000n;
export const ROLE_BYTE = Object.freeze({ game: 1, settlement: 2 });
const roleOfSeat = (b) => Object.keys(ROLE_BYTE).find((k) => ROLE_BYTE[k] === b);
export const SEATING_ROLES = Object.freeze(['game', 'settlement']);

/**
 * When a round's seating closes: start_time - 120 s. A MARKET'S (2026-10-11: "Der prediction market läuft immer z.B.
 * zwischen 19:45 und 20:00. Man darf davor und danach nicht am Markt teilnehmen") is seated 120 s before its WINDOW opens
 * (attested.js marketWindowOf: entry_close - period), so its seats are certified when its first order may come.
 */
export const seatingCloseMs = (contract, window = null) =>
  (window && window.startMs < BigInt(contract.startTimeMs) ? window.startMs : BigInt(contract.startTimeMs)) - SEATING_LEAD_MS;

/** Does this round's certificate carry who was present (protocol 22 on)? */
export const seatingListsPresent = (contract) => !!contract && Number(contract.protocolVersion) >= PRESENCE_VERSION;

/** The threshold a seated committee needs (receiptsNeeded): 5 of 7, 2 of 2. */
export const seatedThreshold = (slots) => (slots === 7 ? 5 : slots === 2 ? 2 : Math.floor(slots / 2) + 1);

const is32Seat = (b) => b instanceof Uint8Array && b.length === 32;
const sameBytesSeat = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cmpSeat = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const keyBytes = (k) => (typeof k === 'string' ? Uint8Array.from(k.match(/../g).map((h) => parseInt(h, 16))) : k);
const sortedKeys = (list) => [...new Map((list || []).map(keyBytes).map((k) => [toHex(k), k])).values()].sort(cmpSeat);
const strictlySorted = (list) => list.every((k, i) => i === 0 || cmpSeat(list[i - 1], k) < 0);

// ---- PRESENT ----
function presentBody({ roundId, role, nodePubkey }) {
  if (!is32Seat(roundId) || !is32Seat(nodePubkey) || !ROLE_BYTE[role]) throw new Error('a PRESENT names a round, a role and a node key');
  const w = new Writer();
  w.u8(TYPE_PRESENT); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(ROLE_BYTE[role]); w.bytes32(nodePubkey);
  return w.finish();
}
export const presentId = (p) => taggedHash(TAG.seatPresent, presentBody(p));
/** A node's PRESENT, signed with its node key: `sign(messageId)` answers 64 bytes. */
export function signPresent({ roundId, role, nodePubkey }, sign) {
  const body = presentBody({ roundId, role, nodePubkey });
  return Uint8Array.from([...body, ...sign(taggedHash(TAG.seatPresent, body))]);
}
export function decodePresent(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_PRESENT) throw new Error('that is not a PRESENT');
  if (!speaksVersion(r.u16())) throw new Error('a PRESENT of another protocol version');
  const roundId = r.bytes32(); const role = roleOfSeat(r.u8()); const nodePubkey = r.bytes32(); const signature = r.bytes(64);
  if (!role) throw new Error('a PRESENT for no role');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the PRESENT');
  return { roundId, role, nodePubkey, signature };
}
/** A PRESENT that stands: decodes, names this round, and is signed by the node it names. */
export function verifyPresent(bytes, { roundId, verify }) {
  let p; try { p = decodePresent(bytes); } catch (e) { return { ok: false, why: e.message }; }
  if (roundId && !sameBytesSeat(p.roundId, roundId)) return { ok: false, why: 'that PRESENT names another round' };
  let good = false; try { good = verify(p.signature, presentId(p), p.nodePubkey); } catch { good = false; }
  return good ? { ok: true, present: p } : { ok: false, why: 'that PRESENT is not signed by the node it names' };
}

// ---- SEATED: who serves ----
/**
 * THE SEATED, from the draw (node keys in score order) and the keys a node holds a PRESENT from: the first min(slots,
 * |present|) present ones in score order. A node seats itself only in that order - a node ranked below a present one is
 * seated only if that one is too.
 */
export function seatedFrom({ drawn, present, slots }) {
  const held = new Set([...present].map((k) => (typeof k === 'string' ? k : toHex(k))));
  return drawn.filter((k) => held.has(toHex(k))).slice(0, slots);
}

// ---- SEATING ----
function seatingBody({ roundId, role, seated }) {
  if (!is32Seat(roundId) || !ROLE_BYTE[role] || !Array.isArray(seated) || !seated.every(is32Seat)) throw new Error('a SEATING names a round, a role and its seated node keys');
  const w = new Writer();
  w.u8(TYPE_SEATING); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(ROLE_BYTE[role]);
  w.vec(seated, (k, ww) => ww.bytes32(k));
  return w.finish();
}
export const seatingId = (s) => taggedHash(TAG.seating, seatingBody(s));
/** One seated node's signature over a seating. */
export const signSeating = (s, sign) => sign(seatingId(s));
// ---- SEEN (protocol 22): one seated node's word on who was present at a seating ----
function seenBody({ roundId, role, seating, present, leftOut }) {
  if (!is32Seat(roundId) || !ROLE_BYTE[role] || !is32Seat(seating)) throw new Error('a SEEN names a round, a role and the seating it goes with');
  const w = new Writer();
  w.u8(TYPE_SEATING_SEEN); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(ROLE_BYTE[role]); w.bytes32(seating);
  w.vec(sortedKeys(present), (k, ww) => ww.bytes32(k));
  w.vec(sortedKeys(leftOut), (k, ww) => ww.bytes32(k));
  return w.finish();
}
/** The id a seated node signs: `seating` the seating's id (seatingId), `present` and `leftOut` node keys (sorted here). */
export const seenId = (s) => taggedHash(TAG.seatingSeen, seenBody(s));
/** One seated node's SEEN signature. */
export const signSeen = (s, sign) => sign(seenId(s));

// ---- JUSTIFICATION (protocol 22, kanban #738): why a node signed a second seating ----
// A node that signed S signs S' only when S can never stand; from 22 its signature over S' carries the proof of that: the
// seating T a member M of S signed, which does not come before S, and M's signature over T. Round and role are the signature's
// own. Encoded:
//
//   vec(of: 32-byte node keys)      S, the seating it shows can never stand, in score order
//   vec(seated: 32-byte node keys)  T, the member's seating, in score order
//   member: 32 bytes                M
//   signature: 64 bytes             M's signature over T (signSeating)
//   u8 0 | 1, then a justification  M's own, when M's signature over T was itself a second one (its `of` the seating M left)
//
// Nested at most JUSTIFICATION_DEPTH deep: only what is encoded can excuse anyone, so justifications never go round in a circle,
// and a chain of them ends at a member that signed a seating not before S with no reason - the one a proof names.
export const JUSTIFICATION_DEPTH = 8;
/** Does seating `a` come before seating `b` (node keys hex, both in score order) in a draw (`rank`: node key hex -> draw index)? */
export function seatingBefore(rank, a, b) {
  if (a.join(',') === b.join(',') || b.length < a.length) return false;
  return a.every((k, i) => rank.has(k) && rank.has(b[i]) && rank.get(b[i]) <= rank.get(k));
}
function writeJustification(j, w, depth = 1) {
  if (!j || !Array.isArray(j.of) || !Array.isArray(j.seated) || !j.of.every(is32Seat) || !j.seated.every(is32Seat) || !is32Seat(j.member)
    || !(j.signature instanceof Uint8Array) || j.signature.length !== 64) throw new Error('a justification names the seating left, the member\'s seating, the member and its signature');
  w.vec(j.of, (k, ww) => ww.bytes32(k));
  w.vec(j.seated, (k, ww) => ww.bytes32(k));
  w.bytes32(j.member); w.bytes(j.signature, 64);
  // deeper than the limit the member's own reason is left off: the justification then excuses the signer, not the member
  if (j.nested && depth < JUSTIFICATION_DEPTH) { w.u8(1); writeJustification(j.nested, w, depth + 1); } else w.u8(0);
}
function readJustification(r, depth = 1) {
  const of = r.vec((x) => x.bytes32()); const seated = r.vec((x) => x.bytes32());
  const member = r.bytes32(); const signature = r.bytes(64);
  const more = r.u8();
  if (more > 1) throw new Error('a justification\'s nested flag is 0 or 1');
  if (more && depth >= JUSTIFICATION_DEPTH) throw new Error(`a justification nests at most ${JUSTIFICATION_DEPTH} deep`);
  return { of, seated, member, signature, nested: more ? readJustification(r, depth + 1) : null };
}
/** A justification's bytes (GET /seating-sig and GET /seating-batch carry them as hex, `justification`). */
export function encodeJustification(j) { const w = new Writer(); writeJustification(j, w); return w.finish(); }
export function decodeJustification(bytes) {
  const r = new Reader(bytes);
  const j = readJustification(r);
  if (r.at !== bytes.length) throw new Error('trailing bytes after the justification');
  return j;
}
/**
 * A JUSTIFICATION THAT STANDS for `signer`'s signature over the seating `onto` (node keys), against the round's draw: `of` (S) and
 * `seated` (T) are seatings of the draw - drawn nodes in score order, no more than the slots; the signer is in S and in `onto`; the
 * member is in S and in T and is not the signer; T does not come before S; `onto` comes after S; the member's signature over T
 * verifies; and a nested justification stands for the member's signature over T. Answers { ok } or { ok: false, why }.
 */
export function verifyJustification(j, { roundId, role, drawn, slots, verify, signer, onto }, depth = 1) {
  if (depth > JUSTIFICATION_DEPTH) return { ok: false, why: `a justification nests at most ${JUSTIFICATION_DEPTH} deep` };
  const rank = new Map(drawn.map((k, i) => [toHex(k), i]));
  const shaped = (list) => list.length >= 1 && list.length <= slots && list.every((k, i) => rank.has(toHex(k)) && (i === 0 || rank.get(toHex(list[i - 1])) < rank.get(toHex(k))));
  if (!shaped(j.of) || !shaped(j.seated) || !shaped(onto)) return { ok: false, why: 'a justification names a seating that is not of drawn nodes in score order within the seats' };
  const of = j.of.map(toHex), seated = j.seated.map(toHex), on = onto.map(toHex), s = toHex(signer), m = toHex(j.member);
  if (!of.includes(s) || !on.includes(s)) return { ok: false, why: 'a justification for a node not in the seating it left or not in the one it signed' };
  if (m === s) return { ok: false, why: 'a justification that names the signer itself' };
  if (!of.includes(m)) return { ok: false, why: `the justification's member ${m.slice(0, 16)} is not in the seating it says can never stand` };
  if (!seated.includes(m)) return { ok: false, why: `the justification's member ${m.slice(0, 16)} is not in its own seating` };
  if (of.join(',') === seated.join(',') || seatingBefore(rank, seated, of)) return { ok: false, why: 'the justification\'s seating comes before the seating left: that one may still stand' };
  if (!seatingBefore(rank, of, on)) return { ok: false, why: 'the seating signed does not come after the seating left' };
  let good = false; try { good = verify(j.signature, seatingId({ roundId, role, seated: j.seated }), j.member); } catch { good = false; }
  if (!good) return { ok: false, why: `the justification's signature is not ${m.slice(0, 16)}'s over its seating` };
  if (j.nested) {
    const n = verifyJustification(j.nested, { roundId, role, drawn, slots, verify, signer: j.member, onto: j.seated }, depth + 1);
    if (!n.ok) return { ok: false, why: `the member's own justification: ${n.why}` };
  }
  return { ok: true };
}

/**
 * THE CERTIFICATE: the body and every signature over it, sorted by node key - and, for a 22 round, `seen`: [{ present, leftOut,
 * signatures }], the seated nodes' SEEN signatures grouped by the lists they signed (each sorted, the groups in id order); then, only
 * when a seated node's signature is a second one (kanban #738), `justifications`: [{ nodePubkey, justification }] sorted by node key,
 * each its justification as above. A certificate with none ends after its SEEN, byte for byte as before.
 */
export function encodeSeatingCertificate({ roundId, role, seated, signatures, seen = null, justifications = null }) {
  const w = new Writer();
  const body = seatingBody({ roundId, role, seated });
  w.bytes(body, body.length);
  const sigs = [...signatures].sort((a, b) => cmpSeat(a.nodePubkey, b.nodePubkey));
  w.vec(sigs, (x, ww) => { ww.bytes32(x.nodePubkey); ww.bytes(x.signature, 64); });
  if (seen) {
    const seating = taggedHash(TAG.seating, body);
    const groups = seen.map((g) => ({ present: sortedKeys(g.present), leftOut: sortedKeys(g.leftOut),
      signatures: [...g.signatures].sort((a, b) => cmpSeat(a.nodePubkey, b.nodePubkey)),
      id: seenId({ roundId, role, seating, present: g.present, leftOut: g.leftOut }) })).sort((a, b) => cmpSeat(a.id, b.id));
    w.vec(groups, (g, ww) => {
      ww.vec(g.present, (k, w3) => w3.bytes32(k));
      ww.vec(g.leftOut, (k, w3) => w3.bytes32(k));
      ww.vec(g.signatures, (x, w3) => { w3.bytes32(x.nodePubkey); w3.bytes(x.signature, 64); });
    });
  }
  if (justifications && justifications.length) {
    if (!seen) throw new Error('a certificate carries justifications only with who was present (protocol 22)');
    w.vec([...justifications].sort((a, b) => cmpSeat(a.nodePubkey, b.nodePubkey)), (x, ww) => { ww.bytes32(x.nodePubkey); writeJustification(x.justification, ww); });
  }
  return w.finish();
}
export function decodeSeatingCertificate(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SEATING) throw new Error('that is not a SEATING');
  if (!speaksVersion(r.u16())) throw new Error('a SEATING of another protocol version');
  const roundId = r.bytes32(); const role = roleOfSeat(r.u8());
  if (!role) throw new Error('a SEATING for no role');
  const seated = r.vec((rr) => rr.bytes32());
  const signatures = r.vec((rr) => ({ nodePubkey: rr.bytes32(), signature: rr.bytes(64) }));
  // a 22 certificate's SEEN groups follow; below 22 the certificate ends here
  const seen = r.at < bytes.length ? r.vec((rr) => ({ present: rr.vec((x) => x.bytes32()), leftOut: rr.vec((x) => x.bytes32()),
    signatures: rr.vec((x) => ({ nodePubkey: x.bytes32(), signature: x.bytes(64) })) })) : null;
  // and its seated nodes' justifications for second signatures, when any (kanban #738)
  const justifications = r.at < bytes.length ? r.vec((rr) => ({ nodePubkey: rr.bytes32(), justification: readJustification(rr) })) : null;
  if (r.at !== bytes.length) throw new Error('trailing bytes after the SEATING');
  return { roundId, role, seated, signatures, seen, justifications };
}

/**
 * A CERTIFICATE THAT STANDS for this round and role, against the draw the checker computed itself: the seated are drawn
 * nodes, in score order, no more than the slots and at least the threshold, each once - and EVERY seated node signed it.
 * `listsPresent` (seatingListsPresent of the round's contract): true for a 22 round - every seated node must also have signed one
 * SEEN over this seating; false below 22 - a certificate carrying SEEN is refused; left out - SEEN is checked when carried. A
 * certificate with SEEN answers `present` (every node any seated node listed, and the seated) and `leftOut` (the nodes every seated
 * node says the round's census left out as absent), node keys hex, sorted.
 */
export function verifySeating(bytes, { roundId, role, drawn, slots, verify, listsPresent = undefined }) {
  let c; try { c = decodeSeatingCertificate(bytes); } catch (e) { return { ok: false, why: e.message }; }
  if (roundId && !sameBytesSeat(c.roundId, roundId)) return { ok: false, why: 'that seating names another round' };
  if (role && c.role !== role) return { ok: false, why: `that seating is for ${c.role}, not ${role}` };
  const t = seatedThreshold(slots);
  if (c.seated.length > slots) return { ok: false, why: `that seating seats ${c.seated.length}, more than the round's ${slots} seats` };
  if (c.seated.length < t) return { ok: false, why: `that seating seats ${c.seated.length}, fewer than the ${t} a round needs: it opens no entries` };
  const rank = new Map(drawn.map((k, i) => [toHex(k), i]));
  let last = -1;
  for (const k of c.seated) {
    const i = rank.get(toHex(k));
    if (i === undefined) return { ok: false, why: `that seating seats ${toHex(k).slice(0, 16)}, which the draw did not draw` };
    if (i <= last) return { ok: false, why: 'that seating is not in score order (or seats a node twice)' };
    last = i;
  }
  const id = seatingId(c);
  const by = new Map(c.signatures.map((x) => [toHex(x.nodePubkey), x.signature]));
  for (const k of c.seated) {
    const sig = by.get(toHex(k));
    if (!sig) return { ok: false, why: `seated node ${toHex(k).slice(0, 16)} did not sign that seating` };
    let good = false; try { good = verify(sig, id, k); } catch { good = false; }
    if (!good) return { ok: false, why: `seated node ${toHex(k).slice(0, 16)}'s signature on that seating does not verify` };
  }
  if (c.seen && listsPresent === false) return { ok: false, why: 'that seating is of a round below protocol 22 and carries a present list' };
  if (!c.seen && listsPresent === true) return { ok: false, why: 'that seating is of a 22 round and names nobody present: every seated node signs who it held a PRESENT of' };
  if (!c.seen && c.justifications) return { ok: false, why: 'that seating carries justifications and nobody present: only a 22 certificate carries them' };
  if (!c.seen) return { ok: true, seating: c, id };
  // WHO WAS PRESENT (protocol 22, kanban #727): every seated node signed exactly one SEEN over this seating
  const seatedHex = new Set(c.seated.map(toHex));
  const drawnHex = new Set(drawn.map((k) => toHex(k)));
  const signed = new Set();
  const present = new Set(seatedHex);
  let leftOut = null;
  for (const g of c.seen) {
    if (!strictlySorted(g.present) || !strictlySorted(g.leftOut) || !strictlySorted(g.signatures.map((x) => x.nodePubkey)))
      return { ok: false, why: 'a present list of that seating is not sorted by node key, or names a node twice' };
    if (!g.signatures.length) return { ok: false, why: 'a present list of that seating is signed by nobody' };
    if (g.leftOut.some((k) => drawnHex.has(toHex(k)))) return { ok: false, why: 'that seating says the round\'s census left out a node the round drew' };
    const sid = seenId({ roundId: c.roundId, role: c.role, seating: id, present: g.present, leftOut: g.leftOut });
    for (const x of g.signatures) {
      const h = toHex(x.nodePubkey);
      if (!seatedHex.has(h)) return { ok: false, why: `${h.slice(0, 16)} signed who was present at that seating and is not seated in it` };
      if (signed.has(h)) return { ok: false, why: `seated node ${h.slice(0, 16)} signed two present lists for that seating` };
      let good = false; try { good = verify(x.signature, sid, x.nodePubkey); } catch { good = false; }
      if (!good) return { ok: false, why: `seated node ${h.slice(0, 16)}'s signature on who was present does not verify` };
      signed.add(h);
    }
    for (const k of g.present) present.add(toHex(k));
    const lo = new Set(g.leftOut.map(toHex));
    leftOut = leftOut === null ? lo : new Set([...leftOut].filter((h) => lo.has(h)));
  }
  for (const k of c.seated) if (!signed.has(toHex(k))) return { ok: false, why: `seated node ${toHex(k).slice(0, 16)} did not sign who was present at that seating` };
  // A SECOND SIGNATURE'S JUSTIFICATION (kanban #738): of a seated node, once, and it stands - a forged one voids the certificate
  if (c.justifications) {
    if (!c.justifications.length) return { ok: false, why: 'that seating carries an empty list of justifications' };
    if (!strictlySorted(c.justifications.map((x) => x.nodePubkey))) return { ok: false, why: 'the justifications of that seating are not sorted by node key, or name a node twice' };
    for (const x of c.justifications) {
      const h = toHex(x.nodePubkey);
      if (!seatedHex.has(h)) return { ok: false, why: `${h.slice(0, 16)} justified a signature on that seating and is not seated in it` };
      const j = verifyJustification(x.justification, { roundId: c.roundId, role: c.role, drawn, slots, verify, signer: x.nodePubkey, onto: c.seated });
      if (!j.ok) return { ok: false, why: `seated node ${h.slice(0, 16)}'s justification does not stand: ${j.why}` };
    }
  }
  return { ok: true, seating: c, id, present: [...present].sort(), leftOut: [...(leftOut || [])].sort() };
}

/**
 * TWO SEATINGS FOR ONE ROUND AND ROLE (§5A.7): each valid against the same draw, and different - proof of equivocation by
 * every node that signed both, but one whose signature on one of them carries a justification (kanban #738) that the other can
 * never stand: NO RULE MAY EVER SLASH AN HONEST SEAT. Its justification names the member that killed the other seating - in it,
 * so it signed that certificate - and that member's signature over a seating not before it: the two are an equivocation of their
 * own, against that member, unless its own justification (nested) shows the same seating could never stand, and so on down.
 * Answers `signers`, every node proved against (never empty while 2 x threshold > drawn); `excused`, the nodes a justification
 * clears; and `signedTwice`, the proofs from justifications - { node, certificate: 'a' | 'b' (the one it signed), seated,
 * signature (its signature over `seated`) }.
 */
export function seatingEquivocation(a, b, check) {
  const x = verifySeating(a, check), y = verifySeating(b, check);
  if (!x.ok) return { ok: false, why: `the first seating does not stand: ${x.why}` };
  if (!y.ok) return { ok: false, why: `the second seating does not stand: ${y.why}` };
  if (!sameBytesSeat(x.seating.roundId, y.seating.roundId) || x.seating.role !== y.seating.role) return { ok: false, why: 'those seatings are for different rounds or roles' };
  if (sameBytesSeat(x.id, y.id)) return { ok: false, why: 'that is one seating twice, not two' };
  const inB = new Set(y.seating.seated.map(toHex));
  const both = x.seating.seated.filter((k) => inB.has(toHex(k)));
  if (!both.length) return { ok: false, why: 'those seatings share no signer' };
  const listOf = (keys) => keys.map(toHex).join(',');
  const justified = (v) => new Map((v.seating.justifications || []).map((j) => [toHex(j.nodePubkey), j.justification]));
  const jx = justified(x), jy = justified(y), xs = listOf(x.seating.seated), ys = listOf(y.seating.seated);
  const proved = new Map(), excused = new Map(), signedTwice = [];
  for (const k of both) {
    const h = toHex(k);
    // its second signature is on b, justified by a never standing - or on a, justified by b never standing
    let j = jy.get(h), certificate = 'a';
    if (!j || listOf(j.of) !== xs) { j = jx.get(h); certificate = 'b'; }
    if (!j || listOf(j.of) !== (certificate === 'a' ? xs : ys)) { proved.set(h, k); continue; }
    excused.set(h, k);
    // the member it names signed `certificate` (it is in that seating) and a seating not before it: excused only by its own reason
    for (let at = j; at; ) {
      const m = toHex(at.member);
      if (at.nested && listOf(at.nested.of) === listOf(at.of)) { excused.set(m, at.member); at = at.nested; continue; }
      if (!proved.has(m)) proved.set(m, at.member);
      signedTwice.push({ node: at.member, certificate, seated: at.seated, signature: at.signature });
      at = null;
    }
  }
  for (const h of proved.keys()) excused.delete(h);
  return { ok: true, signers: [...proved.values()], excused: [...excused.values()], signedTwice, roundId: x.seating.roundId, role: x.seating.role };
}

/**
 * A CERTIFICATE AND A SECOND SIGNATURE (kanban #738): `node` signed the certified seating and, by `signature`, the seating `seated`
 * - proof of equivocation by it unless one of the two signatures carries a justification that the other seating can never stand:
 * `justification` (its justification for `seated`, as GET /seating-sig hands it) or the certificate's own for it. This is the proof
 * a justification yields against the member it names (seatingEquivocation `signedTwice`), and it stands on its own.
 */
export function seatingSignedTwice(cert, { node, seated, signature, justification = null }, check) {
  const x = verifySeating(cert, check);
  if (!x.ok) return { ok: false, why: `the certificate does not stand: ${x.why}` };
  const { roundId, role } = x.seating;
  const h = toHex(node), list = seated.map(toHex), certified = x.seating.seated.map(toHex);
  if (!certified.includes(h)) return { ok: false, why: 'that node is not seated in the certificate' };
  if (list.join(',') === certified.join(',')) return { ok: false, why: 'that is the certified seating, not a second one' };
  const rank = new Map(check.drawn.map((k, i) => [toHex(k), i]));
  if (!list.length || list.length > check.slots || !list.includes(h) || !list.every((k, i) => rank.has(k) && (i === 0 || rank.get(list[i - 1]) < rank.get(k))))
    return { ok: false, why: 'the second seating is not of drawn nodes in score order within the seats, with that node in it' };
  let good = false; try { good = check.verify(signature, seatingId({ roundId, role, seated }), node); } catch { good = false; }
  if (!good) return { ok: false, why: 'that signature is not the node\'s over the second seating' };
  if (justification && justification.of.map(toHex).join(',') === certified.join(',')
    && verifyJustification(justification, { roundId, role, drawn: check.drawn, slots: check.slots, verify: check.verify, signer: node, onto: seated }).ok)
    return { ok: false, why: 'its second signature carries a justification: the certified seating could never stand when it signed' };
  const own = (x.seating.justifications || []).find((j) => toHex(j.nodePubkey) === h);
  if (own && own.justification.of.map(toHex).join(',') === list.join(',')) return { ok: false, why: 'its signature on the certificate carries a justification: the other seating could never stand' };
  return { ok: true, node, roundId, role };
}
