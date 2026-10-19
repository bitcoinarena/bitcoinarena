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
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_PRESENT, TYPE_SEATING, PROTOCOL_VERSION, speaksVersion } from './constants.js';

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

/** The threshold a seated committee needs (receiptsNeeded): 5 of 7, 2 of 2. */
export const seatedThreshold = (slots) => (slots === 7 ? 5 : slots === 2 ? 2 : Math.floor(slots / 2) + 1);

const is32Seat = (b) => b instanceof Uint8Array && b.length === 32;
const sameBytesSeat = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cmpSeat = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

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
/** THE CERTIFICATE: the body and every signature over it, sorted by node key. */
export function encodeSeatingCertificate({ roundId, role, seated, signatures }) {
  const w = new Writer();
  const body = seatingBody({ roundId, role, seated });
  w.bytes(body, body.length);
  const sigs = [...signatures].sort((a, b) => cmpSeat(a.nodePubkey, b.nodePubkey));
  w.vec(sigs, (x, ww) => { ww.bytes32(x.nodePubkey); ww.bytes(x.signature, 64); });
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
  if (r.at !== bytes.length) throw new Error('trailing bytes after the SEATING');
  return { roundId, role, seated, signatures };
}

/**
 * A CERTIFICATE THAT STANDS for this round and role, against the draw the checker computed itself: the seated are drawn
 * nodes, in score order, no more than the slots and at least the threshold, each once - and EVERY seated node signed it.
 */
export function verifySeating(bytes, { roundId, role, drawn, slots, verify }) {
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
  return { ok: true, seating: c, id };
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
