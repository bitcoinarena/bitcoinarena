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
// A CHAIN OF DEPARTURES EXCUSES (kanban #744, RULED 2026-10-28). A proof over two seatings X before Y of one draw stands against a
// node only if it signed both and cannot present a chain X -> S1 -> ... -> Y of justified departures: honest M that signed S, S2
// and T is excused for S and T, whichever seating its citer cited. A second signature carries the signer's steps before with it
// (`prior`), at most 8 steps in all, and a proof that names nobody is a fault record only.
//
// A JUSTIFICATION IS BOUND IN THE SIGNATURE IT EXCUSES (kanban #746, RULED 2026-10-28, option B). Unbound, a lone Byzantine B could
// sign T first, let honest H leave X citing it, sign X too, and then hang a justification citing H's T on its own T: a chain that
// clears B. So from 22 a SEATING signature covers the seating and the hash of its justification (TAG.seatingSigned, the hash of the
// empty string for a first signature), a step counts only with the justification its signer's own signature binds, and a member
// signs each seating of a draw once: two of its signatures over one seating binding different hashes name it, with no excuse. A
// signature can bind only one that exists already, so justifications never cite each other in a circle, and the earliest
// signature by a member of a completed X over a seating conflicting with X has none that stands: its signer is named.
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
//
// A TEMPLATE-3 BOND'S slash_presig IS CHECKED WITH THE SEATING (5A.3B, kanban #972). A seated node signs one per template-3 bond (slash-presig.js), and the certificate carries them after
// its justifications, so whoever holds the certificate holds what a slash needs and a seat has one thing to check. A seating with no template-3 bond in it carries none, byte for byte as
// before. The signature over the seating does not cover them: they sign a transaction, not a seating, and a seating can be signed again without touching them.
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
const presigOrder = (a, b) => cmpSeat(a.nodePubkey, b.nodePubkey) || cmpSeat(a.txid, b.txid) || a.vout - b.vout;

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
/** The hash a 22 SEATING signature binds (kanban #746): of a justification's bytes, or of the empty string for a first signature. */
export const justificationHash = (bytes = null) => taggedHash(TAG.seatingJustification, bytes || new Uint8Array(0));
/** What a 22 seated node signs (kanban #746): the seating id and the hash of its justification, under their own tag. */
export function seatingSignedId(s, jhash) {
  if (!is32Seat(jhash)) throw new Error('a SEATING signature binds a 32-byte justification hash');
  const id = seatingId(s), out = new Uint8Array(64);
  out.set(id, 0); out.set(jhash, 32);
  return taggedHash(TAG.seatingSigned, out);
}
const justificationBytes = (j) => (!j ? null : j instanceof Uint8Array ? j : encodeJustification(j));
/** A 22 seated node's signature over a seating, binding its justification (bytes or the decoded form; none for a first signature). */
export const signSeatingBound = (s, sign, justification = null) => sign(seatingSignedId(s, justificationHash(justificationBytes(justification))));
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
//   signature: 64 bytes             M's signature over T (signSeatingBound)
//   bound: 32 bytes                 the justification hash M's signature over T binds (justificationHash; of the empty string
//                                   when T was M's first)
//   u8 flags                        bit 0: the signer's step before follows (its signature over S was itself a second one)
//   [signature: 64 bytes,           bit 0: the signer's signature over S and the justification it binds - so the whole chain of
//    justification]                 the signer's departures rides with its last signature (kanban #744)
//
// BOUND, NOT NESTED (kanban #746, RULED 2026-10-28). The signature over S' binds the hash of these bytes, and each step names the
// hash M's signature over T binds, so a step needs M's signature and that hash only - M's own reasons are M's to present. The
// signer's steps before are bound the same way: each prior signature binds the justification under it. A justification attached
// to a signature afterwards, or one whose hash the signature does not bind, is no step.
//
// A CHAIN OF DEPARTURES (kanban #744, RULED 2026-10-28). Honest M signs S, then S2, then T, each time because its seating could
// never stand, and H cites M's T to leave S. M's reason for T is about S2, not S - but M left S for S2 with a reason too, so M is
// excused: a node that signed two seatings X before Y of one draw is excused when it presents a chain X = S0 -> S1 -> ... -> Sk =
// Y, strictly increasing, its signature over every Si binding the step that leaves Si-1. The `prior` links carry exactly that chain.
//
// AT MOST JUSTIFICATION_DEPTH STEPS IN ALL - the step and the signer's steps before - so a justification is finite and small. An
// honest seat refuses to sign a seating whose justification would carry more (arena-node seating-agent.js resign).
export const JUSTIFICATION_DEPTH = 8;
// A SILENT MEMBER (§5A.7 RULED 2026-11-07, kanban #1314/#1332): "A drawn node that answers PRESENT and then signs no SEATING does not hold the round:
// a seating that drops a member of S with no signature by seating_close + Δ (Δ = 20 s) counts as coming after S for the ordered rule, with the
// missing signature, attested by the signers' own SEEN record, as the justification". A silent step is flag bit 1: `seated` carries the signer's
// SEEN `present` list (the member among them), `signature` the signer's own SEEN signature over S, `bound` 32 zero bytes, and after the flags
// vec(leftOut) - the SEEN's other list. What it shows is the signer's word that the member was there and did not sign; a slow honest node loses its
// seat to a reserve, which the text accepts.
export const SILENT_AFTER_MS = 20000;
/** How many steps a justification carries in all: itself and the signer's steps before (prior). */
export const justificationSteps = (j) => (j ? 1 + (j.prior ? justificationSteps(j.prior.justification) : 0) : 0);
/** Does seating `a` come before seating `b` (node keys hex, both in score order) in a draw (`rank`: node key hex -> draw index)? */
export function seatingBefore(rank, a, b) {
  if (a.join(',') === b.join(',') || b.length < a.length) return false;
  return a.every((k, i) => rank.has(k) && rank.has(b[i]) && rank.get(b[i]) <= rank.get(k));
}
const listOf = (keys) => keys.map(toHex).join(',');
/** The steps of a justification's own chain, last first: it, then the signer's step before (prior), and so on. */
export function justificationChain(j) { const out = []; for (let at = j; at; at = at.prior ? at.prior.justification : null) out.push(at); return out; }
function writeSteps(j, w) {
  if (j && j.silent) {
    if (!Array.isArray(j.of) || !j.of.every(is32Seat) || !Array.isArray(j.present) || !j.present.every(is32Seat) || !Array.isArray(j.leftOut) || !j.leftOut.every(is32Seat)
      || !is32Seat(j.member) || !(j.signature instanceof Uint8Array) || j.signature.length !== 64) throw new Error('a silent step names the seating left, the SEEN lists, the member and the signer\'s SEEN signature');
    if (j.prior && !(j.prior.signature instanceof Uint8Array && j.prior.signature.length === 64 && j.prior.justification)) throw new Error('a justification\'s step before is the signer\'s signature over the seating left and its justification');
    w.vec(j.of, (k, ww) => ww.bytes32(k)); w.vec(j.present, (k, ww) => ww.bytes32(k));
    w.bytes32(j.member); w.bytes(j.signature, 64); w.bytes32(new Uint8Array(32));
    w.u8((j.prior ? 1 : 0) | 2);
    w.vec(j.leftOut, (k, ww) => ww.bytes32(k));
    if (j.prior) { w.bytes(j.prior.signature, 64); writeSteps(j.prior.justification, w); }
    return;
  }
  if (!j || !Array.isArray(j.of) || !Array.isArray(j.seated) || !j.of.every(is32Seat) || !j.seated.every(is32Seat) || !is32Seat(j.member)
    || !(j.signature instanceof Uint8Array) || j.signature.length !== 64 || !is32Seat(j.bound)) throw new Error('a justification names the seating left, the member\'s seating, the member, its signature and the hash it binds');
  if (j.prior && !(j.prior.signature instanceof Uint8Array && j.prior.signature.length === 64 && j.prior.justification)) throw new Error('a justification\'s step before is the signer\'s signature over the seating left and its justification');
  w.vec(j.of, (k, ww) => ww.bytes32(k));
  w.vec(j.seated, (k, ww) => ww.bytes32(k));
  w.bytes32(j.member); w.bytes(j.signature, 64); w.bytes32(j.bound);
  w.u8(j.prior ? 1 : 0);
  if (j.prior) { w.bytes(j.prior.signature, 64); writeSteps(j.prior.justification, w); }
}
function writeJustification(j, w) {
  // more steps than the cap: refused, never cut - a cut chain could leave out the reason that excuses an honest seat
  if (justificationSteps(j) > JUSTIFICATION_DEPTH) throw new Error(`a justification carries at most ${JUSTIFICATION_DEPTH} steps`);
  writeSteps(j, w);
}
function readJustification(r, budget = { left: JUSTIFICATION_DEPTH }) {
  if (--budget.left < 0) throw new Error(`a justification carries at most ${JUSTIFICATION_DEPTH} steps`);
  const of = r.vec((x) => x.bytes32()); const seated = r.vec((x) => x.bytes32());
  const member = r.bytes32(); const signature = r.bytes(64); const bound = r.bytes32();
  const flags = r.u8();
  if (flags > 3) throw new Error('a justification\'s flags are bits 0 and 1 alone');
  // a silent step (bit 1): `seated` is the signer's SEEN present list, `signature` its SEEN signature, then its leftOut list
  const head = flags & 2 ? { silent: true, of, present: seated, member, signature, leftOut: r.vec((x) => x.bytes32()) } : { of, seated, member, signature, bound };
  if (!(flags & 1)) return head;
  const prior = { signature: r.bytes(64), justification: readJustification(r, budget) };
  return { ...head, prior };
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
 * member is in S and in T and is not the signer; T does not come before S; `onto` comes after S; the member's signature over T,
 * binding `bound`, verifies; and a step before (prior) is the signer's signature over S, binding the justification with it, which
 * stands for it. At most JUSTIFICATION_DEPTH steps in all. With `onto` null the steps are checked without the seating the last one
 * was signed onto. That the signer's own signature over `onto` binds it is for the caller to check. Answers { ok } or { ok: false, why }.
 */
export function verifyJustification(j, ctx) {
  if (justificationSteps(j) > JUSTIFICATION_DEPTH) return { ok: false, why: `a justification carries at most ${JUSTIFICATION_DEPTH} steps` };
  return verifyStep(j, ctx);
}
function verifyStep(j, { roundId, role, drawn, slots, verify, signer, onto }) {
  const rank = new Map(drawn.map((k, i) => [toHex(k), i]));
  const shaped = (list) => list.length >= 1 && list.length <= slots && list.every((k, i) => rank.has(toHex(k)) && (i === 0 || rank.get(toHex(list[i - 1])) < rank.get(toHex(k))));
  if (j.silent) {
    // A SILENT MEMBER (kanban #1332): the member is in S and was PRESENT by the signer's own signed SEEN of S; the seating signed onto seats the
    // signer and drops the member - it counts as coming after S
    if (!shaped(j.of) || (onto && !shaped(onto))) return { ok: false, why: 'a silent step names a seating that is not of drawn nodes in score order within the seats' };
    const of = j.of.map(toHex), s = toHex(signer), m = toHex(j.member), on = onto ? onto.map(toHex) : null;
    if (!of.includes(s) || (on && !on.includes(s))) return { ok: false, why: 'a silent step for a node not in the seating it left or not in the one it signed' };
    if (m === s) return { ok: false, why: 'a silent step that names the signer itself' };
    if (!of.includes(m)) return { ok: false, why: `the silent member ${m.slice(0, 16)} is not in the seating left` };
    if (!j.present.map(toHex).includes(m)) return { ok: false, why: `the signer's SEEN does not hold the silent member ${m.slice(0, 16)} present` };
    if (on && on.includes(m)) return { ok: false, why: 'the seating signed still seats the silent member' };
    let seen = false;
    try { seen = verify(j.signature, seenId({ roundId, role, seating: seatingId({ roundId, role, seated: j.of }), present: j.present, leftOut: j.leftOut }), signer); } catch { seen = false; }
    if (!seen) return { ok: false, why: `the silent step's SEEN is not ${s.slice(0, 16)}'s signature over the seating left` };
    if (j.prior) {
      let mine = false;
      try { mine = verify(j.prior.signature, seatingSignedId({ roundId, role, seated: j.of }, justificationHash(encodeJustification(j.prior.justification))), signer); } catch { mine = false; }
      if (!mine) return { ok: false, why: `the signer ${s.slice(0, 16)}'s signature over the seating it left does not verify, binding the justification with it` };
      const p = verifyStep(j.prior.justification, { roundId, role, drawn, slots, verify, signer, onto: j.of });
      if (!p.ok) return { ok: false, why: `the signer's step before: ${p.why}` };
    }
    return { ok: true };
  }
  if (!shaped(j.of) || !shaped(j.seated) || (onto && !shaped(onto))) return { ok: false, why: 'a justification names a seating that is not of drawn nodes in score order within the seats' };
  const of = j.of.map(toHex), seated = j.seated.map(toHex), s = toHex(signer), m = toHex(j.member);
  const on = onto ? onto.map(toHex) : null;
  if (!of.includes(s) || (on && !on.includes(s))) return { ok: false, why: 'a justification for a node not in the seating it left or not in the one it signed' };
  if (m === s) return { ok: false, why: 'a justification that names the signer itself' };
  if (!of.includes(m)) return { ok: false, why: `the justification's member ${m.slice(0, 16)} is not in the seating it says can never stand` };
  if (!seated.includes(m)) return { ok: false, why: `the justification's member ${m.slice(0, 16)} is not in its own seating` };
  if (of.join(',') === seated.join(',') || seatingBefore(rank, seated, of)) return { ok: false, why: 'the justification\'s seating comes before the seating left: that one may still stand' };
  if (on && !seatingBefore(rank, of, on)) return { ok: false, why: 'the seating signed does not come after the seating left' };
  let good = false; try { good = verify(j.signature, seatingSignedId({ roundId, role, seated: j.seated }, j.bound), j.member); } catch { good = false; }
  if (!good) return { ok: false, why: `the justification's signature is not ${m.slice(0, 16)}'s over its seating, binding the hash it names` };
  if (j.prior) {
    // THE SIGNER'S STEP BEFORE (kanban #744): its own signature over the seating it left, binding why it signed that one (#746)
    let mine = false;
    try { mine = verify(j.prior.signature, seatingSignedId({ roundId, role, seated: j.of }, justificationHash(encodeJustification(j.prior.justification))), signer); } catch { mine = false; }
    if (!mine) return { ok: false, why: `the signer ${s.slice(0, 16)}'s signature over the seating it left does not verify, binding the justification with it` };
    const p = verifyStep(j.prior.justification, { roundId, role, drawn, slots, verify, signer, onto: j.of });
    if (!p.ok) return { ok: false, why: `the signer's step before: ${p.why}` };
  }
  return { ok: true };
}

/**
 * THE CERTIFICATE: the body and every signature over it, sorted by node key - and, for a 22 round, `seen`: [{ present, leftOut,
 * signatures }], the seated nodes' SEEN signatures grouped by the lists they signed (each sorted, the groups in id order); then, only
 * when a seated node's signature is a second one (kanban #738), `justifications`: [{ nodePubkey, justification }] sorted by node key,
 * each its justification as above. A certificate with none ends after its SEEN, byte for byte as before. Then, only when a seated node holds a template-3 bond (kanban #972), `presigs`:
 * [{ nodePubkey, txid, vout, signature (65 bytes) }] sorted by node key and outpoint, after a justification list that may be empty.
 */
export function encodeSeatingCertificate({ roundId, role, seated, signatures, seen = null, justifications = null, presigs = null }) {
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
  const carriesPresigs = !!(presigs && presigs.length);
  if ((justifications && justifications.length) || carriesPresigs) {
    if (!seen) throw new Error('a certificate carries justifications and presigs only with who was present (protocol 22)');
    w.vec([...(justifications || [])].sort((a, b) => cmpSeat(a.nodePubkey, b.nodePubkey)), (x, ww) => { ww.bytes32(x.nodePubkey); writeJustification(x.justification, ww); });
  }
  if (carriesPresigs) w.vec([...presigs].sort(presigOrder), (x, ww) => { ww.bytes32(x.nodePubkey); ww.bytes32(x.txid); ww.u32(x.vout); ww.bytes(x.signature, 65); });
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
  // and the template-3 bonds' presigs, when any (kanban #972); an empty justification list is written only ahead of them
  const presigs = r.at < bytes.length ? r.vec((rr) => ({ nodePubkey: rr.bytes32(), txid: rr.bytes32(), vout: rr.u32(), signature: rr.bytes(65) })) : null;
  if (r.at !== bytes.length) throw new Error('trailing bytes after the SEATING');
  return { roundId, role, seated, signatures, seen, justifications: presigs && justifications && !justifications.length ? null : justifications, ...(presigs ? { presigs } : {}) };
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
  if (c.seen && listsPresent === false) return { ok: false, why: 'that seating is of a round below protocol 22 and carries a present list' };
  if (!c.seen && listsPresent === true) return { ok: false, why: 'that seating is of a 22 round and names nobody present: every seated node signs who it held a PRESENT of' };
  if (!c.seen && c.justifications) return { ok: false, why: 'that seating carries justifications and nobody present: only a 22 certificate carries them' };
  // A 22 SIGNATURE BINDS ITS JUSTIFICATION (kanban #746): a seated node's is over the seating and the hash of the justification the
  // certificate carries for it, or of the empty string when it carries none; below 22 over the seating id alone, as before
  const jOf = new Map((c.justifications || []).map((x) => [toHex(x.nodePubkey), x.justification]));
  const signedId = (k) => (c.seen ? seatingSignedId(c, justificationHash(jOf.has(toHex(k)) ? encodeJustification(jOf.get(toHex(k))) : null)) : id);
  const by = new Map(c.signatures.map((x) => [toHex(x.nodePubkey), x.signature]));
  for (const k of c.seated) {
    const sig = by.get(toHex(k));
    if (!sig) return { ok: false, why: `seated node ${toHex(k).slice(0, 16)} did not sign that seating` };
    let good = false; try { good = verify(sig, signedId(k), k); } catch { good = false; }
    if (!good) return { ok: false, why: `seated node ${toHex(k).slice(0, 16)}'s signature on that seating does not verify${c.seen ? ' with the justification it carries' : ''}` };
  }
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
 * THE PRESIGS OF A CERTIFICATE AGAINST WHAT THE ROUND ASKS (5A.3B, kanban #972): `plan`, roundPresigPlan's Map, node key hex -> [{ txid hex, vout, digest }]. Every bond of every seated node
 * has its presig and it verifies, and nothing else is carried. `presigStands(signature, digest, nodeKey)` is the caller's. A client passes no plan: this stays with the seats.
 * Answers { ok } or { ok: false, why }.
 */
export function checkSeatingPresigs(certificate, plan, presigStands) {
  const given = certificate.presigs || [];
  if (!strictlyOrdered(given)) return { ok: false, why: 'the presigs of that seating are not sorted by node and outpoint, or name a bond twice' };
  const asked = certificate.seated.flatMap((k) => (plan.get(toHex(k)) || []).map((b) => ({ ...b, nodePubkey: k })));
  const by = new Map(given.map((p) => [`${toHex(p.nodePubkey)}:${toHex(p.txid)}:${p.vout}`, p]));
  for (const b of asked) {
    const p = by.get(`${toHex(b.nodePubkey)}:${b.txid}:${b.vout}`);
    if (!p) return { ok: false, why: `seated node ${toHex(b.nodePubkey).slice(0, 16)} gave no slash_presig for its bond ${b.txid.slice(0, 16)}:${b.vout}` };
    if (!presigStands(p.signature, b.digest, b.nodePubkey)) return { ok: false, why: `seated node ${toHex(b.nodePubkey).slice(0, 16)}'s slash_presig for its bond ${b.txid.slice(0, 16)}:${b.vout} does not verify` };
  }
  if (given.length !== asked.length) return { ok: false, why: 'that seating carries a presig the round does not ask for' };
  return { ok: true };
}
function strictlyOrdered(list) { return list.every((x, i) => i === 0 || presigOrder(list[i - 1], x) < 0); }

// ---- THE JUDGE (kanban #744, #746, RULED 2026-10-28) ----
// A proof over two seatings X before Y of one draw stands against a node only if it signed both and cannot present a valid chain
// X = S0 -> ... -> Sk = Y (justificationChain) bound in its own signatures: the justification its signature over Y binds, whose
// steps before each sit in its signature over the seating left. What it can present: the justifications the certificates carry
// (each bound in the certificate's signature), the steps before in those, and whatever the judge holds itself (`presented`:
// [{ nodePubkey, seated, signature, justification? | justificationHash? }] - a signature with the justification it binds, or with
// the hash alone; a seat passes every signature it holds). A justification no signature binds is no step.
//
// ONE SEATING, SIGNED ONCE (kanban #746). Every signature the judge holds - the certificates', each step's member's, each step
// before's, the presented ones - is kept by signer and seating with the hash it binds; a signer with two over one seating binding
// different hashes is named on that alone, with no excuse.
function judgeOf(certs, check, presented) {
  const { roundId, role } = certs[0].seating;
  const ctx = { roundId, role, drawn: check.drawn, slots: check.slots, verify: check.verify };
  const rank = new Map(check.drawn.map((k, i) => [toHex(k), i]));
  const pool = [], lasts = [], sigs = new Map();
  // below 22 no signature binds a justification: nothing excuses, nothing is signed twice over one seating
  if (!certs.every((v) => v.seating.seen)) return { pool, excused: () => false, doubles: () => [] };
  const ids = new Map();
  const sid = (list) => { const l = listOf(list); if (!ids.has(l)) ids.set(l, toHex(seatingId({ roundId, role, seated: list }))); return ids.get(l); };
  const record = (node, seated, hash, signature) => {
    const key = `${toHex(node)}|${sid(seated)}`;
    if (!sigs.has(key)) sigs.set(key, { node, seated, by: new Map() });
    const by = sigs.get(key).by;
    if (!by.has(toHex(hash))) by.set(toHex(hash), { signature, justificationHash: hash });
  };
  // a signature by `node` over `seated` binding `j` (null: a first signature) - checked already - and every step it carries
  const addBound = (node, seated, j, signature) => {
    record(node, seated, justificationHash(j ? encodeJustification(j) : null), signature);
    if (!j) return;
    lasts.push({ node: toHex(node), to: sid(seated), j });
    pool.push({ signer: toHex(node), j });
    // a silent step carries no signature of the member's (kanban #1332): only the signer's own SEEN, nothing to record as a seating signature
    if (!j.silent) record(j.member, j.seated, j.bound, j.signature);
    if (j.prior) addBound(node, j.of, j.prior.justification, j.prior.signature);
  };
  // the certificates' signatures, each binding the justification the certificate carries for it (verifySeating checked them)
  for (const v of certs) {
    const jOf = new Map((v.seating.justifications || []).map((x) => [toHex(x.nodePubkey), x.justification]));
    const by = new Map(v.seating.signatures.map((x) => [toHex(x.nodePubkey), x.signature]));
    for (const k of v.seating.seated) addBound(k, v.seating.seated, jOf.get(toHex(k)) || null, by.get(toHex(k)));
  }
  // the presented ones, checked here: the signature over its seating binds what it comes with, and a justification stands
  const shaped = (list, node) => Array.isArray(list) && list.length >= 1 && list.length <= check.slots && list.every(is32Seat)
    && list.some((k) => sameBytesSeat(k, node)) && list.every((k, i) => rank.has(toHex(k)) && (i === 0 || rank.get(toHex(list[i - 1])) < rank.get(toHex(k))));
  for (const x of presented || []) {
    if (!x || !is32Seat(x.nodePubkey) || !shaped(x.seated, x.nodePubkey) || !(x.signature instanceof Uint8Array)) continue;
    let hash;
    try { hash = x.justification ? justificationHash(encodeJustification(x.justification)) : is32Seat(x.justificationHash) ? x.justificationHash : justificationHash(null); } catch { continue; }
    let good = false; try { good = check.verify(x.signature, seatingSignedId({ roundId, role, seated: x.seated }, hash), x.nodePubkey); } catch { good = false; }
    if (!good) continue;
    if (x.justification && verifyJustification(x.justification, { ...ctx, signer: x.nodePubkey, onto: x.seated }).ok) addBound(x.nodePubkey, x.seated, x.justification, x.signature);
    else record(x.nodePubkey, x.seated, hash, x.signature);
  }
  /** Does `node` (hex) present a chain between the seatings `a` and `b` (node keys), from the earlier to the later, bound in its signatures? */
  const excused = (node, a, b) => {
    const ah = a.map(toHex), bh = b.map(toHex);
    const [from, to] = seatingBefore(rank, ah, bh) ? [a, b] : seatingBefore(rank, bh, ah) ? [b, a] : [null, null];
    if (!from) return false;   // neither comes before the other: no chain joins them
    const f = listOf(from), t = sid(to);
    return lasts.some((e) => e.node === node && e.to === t && justificationChain(e.j).some((s) => listOf(s.of) === f));
  };
  /** Every signer with two signatures over one seating binding different hashes: { node, seated, signatures: [two of them] }. */
  const doubles = () => [...sigs.values()].filter((s) => s.by.size > 1).map((s) => ({ node: s.node, seated: s.seated, signatures: [...s.by.values()].slice(0, 2) }));
  return { pool, excused, doubles };
}

/**
 * TWO SEATINGS FOR ONE ROUND AND ROLE (§5A.7): each valid against the same draw, and different - the round is void. Proof of
 * equivocation by every node that signed both, but one that presents a chain of justified departures from the earlier to the later,
 * bound in its own signatures (kanban #744, #746): NO RULE MAY EVER SLASH AN HONEST SEAT. Every step of a chain names the member that
 * killed the seating it left; a member of one of the two certificates signed it, and its seating not before it: the two are an
 * equivocation of their own against that member, unless it presents a chain between them in turn. A node that signed one seating
 * twice, binding two hashes, is proved against with no excuse (kanban #746). Answers `signers`, every node proved against;
 * `excused`, the nodes a chain clears; `signedTwice`, the proofs from the steps - { node, certificate: 'a' | 'b' (the one it signed),
 * seated, signature (its signature over `seated`), justificationHash (the hash that signature binds) }; `doubleSigned`, { node,
 * seated, signatures: [{ signature, justificationHash }, two] }; and `unnamed`: true when it names nobody - every signer of both
 * excused - a fault record that feeds no slash, exclusion or reputation count. `presented`: what the judge holds besides (judgeOf).
 */
export function seatingEquivocation(a, b, check, presented = []) {
  const x = verifySeating(a, check), y = verifySeating(b, check);
  if (!x.ok) return { ok: false, why: `the first seating does not stand: ${x.why}` };
  if (!y.ok) return { ok: false, why: `the second seating does not stand: ${y.why}` };
  if (!sameBytesSeat(x.seating.roundId, y.seating.roundId) || x.seating.role !== y.seating.role) return { ok: false, why: 'those seatings are for different rounds or roles' };
  if (sameBytesSeat(x.id, y.id)) return { ok: false, why: 'that is one seating twice, not two' };
  const inB = new Set(y.seating.seated.map(toHex));
  const both = x.seating.seated.filter((k) => inB.has(toHex(k)));
  if (!both.length) return { ok: false, why: 'those seatings share no signer' };
  const { pool, excused: hasChain, doubles } = judgeOf([x, y], check, presented);
  const doubleSigned = doubles();
  const twice = new Set(doubleSigned.map((d) => toHex(d.node)));
  const clears = (h, s1, s2) => !twice.has(h) && hasChain(h, s1, s2);
  const proved = new Map(), excused = new Map(), signedTwice = [], seen = new Set();
  for (const k of both) (clears(toHex(k), x.seating.seated, y.seating.seated) ? excused : proved).set(toHex(k), k);
  // EVERY STEP THAT LEAVES ONE OF THE TWO: its member signed that certificate and the member's own seating
  for (const [certificate, v] of [['a', x], ['b', y]]) {
    const c = listOf(v.seating.seated);
    for (const e of pool) {
      if (listOf(e.j.of) !== c) continue;
      const m = toHex(e.j.member);
      if (clears(m, v.seating.seated, e.j.seated)) { excused.set(m, e.j.member); continue; }
      if (!proved.has(m)) proved.set(m, e.j.member);
      const key = `${m}|${certificate}|${listOf(e.j.seated)}`;
      if (!seen.has(key)) { seen.add(key); signedTwice.push({ node: e.j.member, certificate, seated: e.j.seated, signature: e.j.signature, justificationHash: e.j.bound }); }
    }
  }
  // ONE SEATING SIGNED TWICE (kanban #746): named on its own
  for (const d of doubleSigned) if (!proved.has(toHex(d.node))) proved.set(toHex(d.node), d.node);
  for (const h of proved.keys()) excused.delete(h);
  return { ok: true, signers: [...proved.values()], excused: [...excused.values()], signedTwice, doubleSigned, unnamed: proved.size === 0, roundId: x.seating.roundId, role: x.seating.role };
}

/**
 * A CERTIFICATE AND A SECOND SIGNATURE (kanban #738): `node` signed the certified seating and, by `signature`, the seating `seated`
 * - proof of equivocation by it unless it presents a chain of justified departures between the two (kanban #744) bound in its
 * signatures (#746): `justification` (the one `signature` binds, as GET /seating-sig hands it), the certificate's, or `presented`.
 * This is the proof a step yields against the member it names (seatingEquivocation `signedTwice`), and it stands on its own. In a 22
 * round `signature` binds `justification`'s hash, or `justificationHash` when only that is known, or the empty string's. And from 22
 * `seated` may be the certified seating itself: a signature over it binding another hash than the certificate's is the proof that
 * the node signed one seating twice (`double`), with no excuse.
 */
export function seatingSignedTwice(cert, { node, seated, signature, justification = null, justificationHash: jh = null }, check, presented = []) {
  const x = verifySeating(cert, check);
  if (!x.ok) return { ok: false, why: `the certificate does not stand: ${x.why}` };
  const { roundId, role } = x.seating;
  const bound = !!x.seating.seen;
  const h = toHex(node), list = seated.map(toHex), certified = x.seating.seated.map(toHex);
  if (!certified.includes(h)) return { ok: false, why: 'that node is not seated in the certificate' };
  const same = list.join(',') === certified.join(',');
  if (same && !bound) return { ok: false, why: 'that is the certified seating, not a second one' };
  const rank = new Map(check.drawn.map((k, i) => [toHex(k), i]));
  if (!list.length || list.length > check.slots || !list.includes(h) || !list.every((k, i) => rank.has(k) && (i === 0 || rank.get(list[i - 1]) < rank.get(k))))
    return { ok: false, why: 'the second seating is not of drawn nodes in score order within the seats, with that node in it' };
  let hash = null;
  if (bound) { try { hash = justification ? justificationHash(encodeJustification(justification)) : jh || justificationHash(null); } catch (e) { return { ok: false, why: `that justification: ${e.message}` }; } }
  let good = false; try { good = check.verify(signature, bound ? seatingSignedId({ roundId, role, seated }, hash) : seatingId({ roundId, role, seated }), node); } catch { good = false; }
  if (!good) return { ok: false, why: bound ? 'that signature is not the node\'s over the second seating, binding that justification' : 'that signature is not the node\'s over the second seating' };
  if (!bound) return { ok: true, node, roundId, role };
  const { excused, doubles } = judgeOf([x], check, [{ nodePubkey: node, seated, signature, justification, justificationHash: hash }, ...(presented || [])]);
  const d = doubles().find((s) => toHex(s.node) === h);
  if (d) return { ok: true, node, roundId, role, double: true, seated: d.seated };
  if (same) return { ok: false, why: 'that is the certified seating, signed once' };
  if (excused(h, x.seating.seated, seated)) return { ok: false, why: 'it carries a justification for every step between the two seatings: each one it left could never stand when it signed the next' };
  return { ok: true, node, roundId, role };
}
