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
// seats, and each node signs at most one per round and role. Two valid seatings for one round and role always share a
// signer (2 x threshold > drawn), so two certificates are proof of equivocation by that signer: the round is void (§13C)
// and the signer's bond is slashable (§5A.3B). A client enters a round only with a certificate it checked against the draw
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

/**
 * THE CERTIFICATE: the body and every signature over it, sorted by node key - and, for a 22 round, `seen`: [{ present, leftOut,
 * signatures }], the seated nodes' SEEN signatures grouped by the lists they signed (each sorted, the groups in id order).
 */
export function encodeSeatingCertificate({ roundId, role, seated, signatures, seen = null }) {
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
  if (r.at !== bytes.length) throw new Error('trailing bytes after the SEATING');
  return { roundId, role, seated, signatures, seen };
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
  return { ok: true, seating: c, id, present: [...present].sort(), leftOut: [...(leftOut || [])].sort() };
}

/**
 * TWO SEATINGS FOR ONE ROUND AND ROLE (§5A.7): each valid against the same draw, and different - proof of equivocation by
 * every node that signed both. Answers those nodes (never empty while 2 x threshold > drawn).
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
  return { ok: true, signers: both, roundId: x.seating.roundId, role: x.seating.role };
}
