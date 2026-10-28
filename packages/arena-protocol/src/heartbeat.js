// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEARTBEAT (multiplayer_p2p.md §5A.3 "The heartbeat", protocol 22, kanban #727, the owner 2026-10-27).
//
// WHY. A node leaves a 22 census only on proof (presence.js): threshold-signed certificates of 3 moments of the 24 h that show it
// missed. Seating certificates alone were that proof, and a seating certificate exists only when 5 of a round's 9 drawn are present.
// On 10-27 (28 bonded, 20 stopped) almost no round reached 5, so almost nothing was proven: the days seated 1, 7, 56, then 96 of 96
// rounds, and the stopped nodes were out only by the third census. the owner chose a heartbeat, so a stopped node is proven out within a day.
//
// WHAT.
//   slot        a 22 round that seats itself (not a table's later round) has HEARTBEAT_SLOTS_PER_ROUND heartbeat slots j = 0 ..,
//               closing at seating_close - j x HEARTBEAT_SPACING_MS. the owner 2026-10-27 ruled 1 slot per round: it closes with
//               the round's seating, and a 15-min grid gives one every 15 min, 96 a day (constants.js has the trade-off)
//   committee   HEARTBEAT_DRAWN node keys of the round's census, drawn as its committees are (one key one seat, weighed by bond) on
//               their own seed H("ARENA/v1/HeartbeatDraw" || committee seed || j) - every seat and the client draw the sameBeat 9 from the
//               round's census and beacon, which they already check for the round's seating
//   HEARTBEAT   every node of the round's census, and every node its census left out as absent (that is how it comes back), signs
//               HEARTBEAT(round, j, node) and hands it to the slot's committee before the slot's close
//   HEARD       each live member signs, after the close, the sorted node keys it held a HEARTBEAT of, and the nodes the round's census
//               left out; members exchange them
//   certificate the HEARDs of at least HEARTBEAT_THRESHOLD = 5 distinct members of the slot's committee. Every node any signer lists,
//               and every signer, was present at the slot; every other node of the round's census, or left out by it, missed it
//
// WHY IT IS SAFE (the sameBeat bar as a seating certificate). A certificate needs 5 signatures of the slot's committee, so no group of
// fewer than 5 nodes can make one, ever. To leave out an honest node a group must hold 5 of the 9 seats of a random draw at 3
// different moments of one day - the draw is the round's beacon's, after the round was posted. With 5 of 9, two certificates of one
// slot share a signer, so a member that signed two different HEARDs for one slot has equivocated. On top, every seat that holds a
// node's HEARTBEAT of the 24 h refuses a census that leaves it out (presence-book.js), and a live node hands its heartbeats to 9
// members every 15 min, so nearly every seat holds one.
//
// WHAT IT COSTS. Per node per day: 96 x 9 HEARTBEATs out (132 bytes each, ~114 KB), as many in as a member on average, and one HEARD
// per membership to 8 others; a seat keeps its memberships' certificates. See §5A.3 for the numbers.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_HEARTBEAT, TYPE_HEARTBEAT_HEARD, PROTOCOL_VERSION, speaksVersion,
  HEARTBEAT_SLOTS_PER_ROUND, HEARTBEAT_SPACING_MS, HEARTBEAT_DRAWN, HEARTBEAT_THRESHOLD, PRESENCE_VERSION } from './constants.js';
import { selectCommittee } from './sortition.js';
import { seatingCloseMs } from './seating.js';
import { tableAnchorOf } from './known-game.js';

export { HEARTBEAT_SLOTS_PER_ROUND, HEARTBEAT_SPACING_MS, HEARTBEAT_DRAWN, HEARTBEAT_THRESHOLD };
/** A HEARTBEAT's length: type, version, round id, slot, node key, signature. */
export const HEARTBEAT_BYTES = 1 + 2 + 32 + 1 + 32 + 64;
/** The slots of a round, as the proof names them (presence.js): `heartbeat-0` .. `heartbeat-2`. */
export const HEARTBEAT_ROLES = Object.freeze(Array.from({ length: HEARTBEAT_SLOTS_PER_ROUND }, (_, j) => `heartbeat-${j}`));
export const heartbeatRole = (j) => `heartbeat-${j}`;
/** The slot a proof role names, or null for a seating role. */
export const heartbeatSlotOf = (role) => {
  const m = /^heartbeat-(\d+)$/.exec(String(role || ''));
  const j = m ? Number(m[1]) : null;
  return j !== null && j < HEARTBEAT_SLOTS_PER_ROUND ? j : null;
};

const is32Beat = (b) => b instanceof Uint8Array && b.length === 32;
const sameBeat = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cmpBeat = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const keyBytesBeat = (k) => (typeof k === 'string' ? Uint8Array.from(k.match(/../g).map((h) => parseInt(h, 16))) : k);
const hexOfBeat = (k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k));
const sortedKeysBeat = (list) => [...new Map((list || []).map(keyBytesBeat).map((k) => [toHex(k), k])).values()].sort(cmpBeat);
const strictlySortedBeat = (list) => list.every((k, i) => i === 0 || cmpBeat(list[i - 1], k) < 0);
const slotOkBeat = (j) => Number.isInteger(j) && j >= 0 && j < HEARTBEAT_SLOTS_PER_ROUND;

/**
 * DOES THIS ROUND HAVE HEARTBEAT SLOTS: a 22 round that seats itself. A table's later rounds share its first round's draw, so slots of
 * theirs would let one lucky committee sign at many moments - they have none.
 */
export function hasHeartbeats(contract) {
  if (!contract || Number(contract.protocolVersion) < PRESENCE_VERSION || typeof contract.startTimeMs !== 'bigint') return false;
  const anchor = tableAnchorOf(contract);
  return !(anchor && !anchor.first);
}
/** When heartbeat slot j of a round closes: its seating close less j x 5 min. */
export const heartbeatCloseMs = (contract, j) => seatingCloseMs(contract) - BigInt(j) * HEARTBEAT_SPACING_MS;

/** THE SLOT'S COMMITTEE: HEARTBEAT_DRAWN entries of the round's census, on the round's committee seed and the slot. */
export function drawHeartbeat({ entries, contract, committeeSeed, slot }) {
  if (!is32Beat(committeeSeed)) throw new Error('a heartbeat committee is drawn on the seed the round\'s beacon produced');
  if (!slotOkBeat(slot)) throw new Error(`a round has heartbeat slots 0 to ${HEARTBEAT_SLOTS_PER_ROUND - 1}`);
  const w = new Writer(); w.bytes32(committeeSeed); w.u8(slot);
  return selectCommittee({ entries, contract, role: 'settlement', committeeSeed: taggedHash(TAG.heartbeatDraw, w.finish()), count: HEARTBEAT_DRAWN });
}

// ---- HEARTBEAT: a node's word that it is up, for one slot ----
function heartbeatBody({ roundId, slot, nodePubkey }) {
  if (!is32Beat(roundId) || !slotOkBeat(slot) || !is32Beat(nodePubkey)) throw new Error('a HEARTBEAT names a round, a slot and a node key');
  const w = new Writer();
  w.u8(TYPE_HEARTBEAT); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(slot); w.bytes32(nodePubkey);
  return w.finish();
}
export const heartbeatId = (h) => taggedHash(TAG.heartbeat, heartbeatBody(h));
export function signHeartbeat({ roundId, slot, nodePubkey }, sign) {
  const body = heartbeatBody({ roundId, slot, nodePubkey });
  return Uint8Array.from([...body, ...sign(taggedHash(TAG.heartbeat, body))]);
}
export function decodeHeartbeat(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_HEARTBEAT) throw new Error('that is not a HEARTBEAT');
  if (!speaksVersion(r.u16())) throw new Error('a HEARTBEAT of another protocol version');
  const roundId = r.bytes32(); const slot = r.u8(); const nodePubkey = r.bytes32(); const signature = r.bytes(64);
  if (!slotOkBeat(slot)) throw new Error('a HEARTBEAT for no slot');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the HEARTBEAT');
  return { roundId, slot, nodePubkey, signature };
}
/** A HEARTBEAT that stands: decodes, names this round (when given), and is signed by the node it names. */
export function verifyHeartbeat(bytes, { roundId = null, verify }) {
  let h; try { h = decodeHeartbeat(bytes); } catch (e) { return { ok: false, why: e.message }; }
  if (roundId && !sameBeat(h.roundId, roundId)) return { ok: false, why: 'that HEARTBEAT names another round' };
  let good = false; try { good = verify(h.signature, heartbeatId(h), h.nodePubkey); } catch { good = false; }
  return good ? { ok: true, heartbeat: h } : { ok: false, why: 'that HEARTBEAT is not signed by the node it names' };
}

// ---- HEARD: one member's word on who it held a HEARTBEAT of at the slot's close ----
function heardBody({ roundId, slot, heard, leftOut }) {
  if (!is32Beat(roundId) || !slotOkBeat(slot)) throw new Error('a HEARD names a round and a slot');
  const w = new Writer();
  w.u8(TYPE_HEARTBEAT_HEARD); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(slot);
  w.vec(sortedKeysBeat(heard), (k, ww) => ww.bytes32(k));
  w.vec(sortedKeysBeat(leftOut), (k, ww) => ww.bytes32(k));
  return w.finish();
}
export const heardId = (h) => taggedHash(TAG.heartbeatHeard, heardBody(h));
export const signHeard = (h, sign) => sign(heardId(h));

/**
 * THE HEARTBEAT CERTIFICATE: type, version, round, slot, and the members' HEARDs grouped by the lists they signed - [{ heard, leftOut,
 * signatures: [{ nodePubkey, signature }] }], each list sorted, the signatures by key, the groups by HEARD id.
 */
export function encodeHeartbeatCertificate({ roundId, slot, groups }) {
  if (!is32Beat(roundId) || !slotOkBeat(slot)) throw new Error('a heartbeat certificate names a round and a slot');
  const w = new Writer();
  w.u8(TYPE_HEARTBEAT_HEARD); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(slot);
  const gs = groups.map((g) => ({ heard: sortedKeysBeat(g.heard), leftOut: sortedKeysBeat(g.leftOut),
    signatures: [...g.signatures].map((x) => ({ nodePubkey: keyBytesBeat(x.nodePubkey), signature: x.signature })).sort((a, b) => cmpBeat(a.nodePubkey, b.nodePubkey)),
    id: heardId({ roundId, slot, heard: g.heard, leftOut: g.leftOut }) })).sort((a, b) => cmpBeat(a.id, b.id));
  w.vec(gs, (g, ww) => {
    ww.vec(g.heard, (k, w3) => w3.bytes32(k));
    ww.vec(g.leftOut, (k, w3) => w3.bytes32(k));
    ww.vec(g.signatures, (x, w3) => { w3.bytes32(x.nodePubkey); w3.bytes(x.signature, 64); });
  });
  return w.finish();
}
export function decodeHeartbeatCertificate(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_HEARTBEAT_HEARD) throw new Error('that is not a heartbeat certificate');
  if (!speaksVersion(r.u16())) throw new Error('a heartbeat certificate of another protocol version');
  const roundId = r.bytes32(); const slot = r.u8();
  if (!slotOkBeat(slot)) throw new Error('a heartbeat certificate for no slot');
  const groups = r.vec((rr) => ({ heard: rr.vec((x) => x.bytes32()), leftOut: rr.vec((x) => x.bytes32()),
    signatures: rr.vec((x) => ({ nodePubkey: x.bytes32(), signature: x.bytes(64) })) }));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the heartbeat certificate');
  return { roundId, slot, groups };
}

/**
 * A HEARTBEAT CERTIFICATE THAT STANDS, against the committee and the round's census the checker drew itself: at least
 * HEARTBEAT_THRESHOLD distinct members of `committee` each signed exactly one HEARD, and none says the census left out a node the census
 * holds. Answers { ok, signers, heard, leftOut } (keys hex, sorted): `heard` every node any signer listed, and the signers; `leftOut` the
 * nodes every signer says the round's census left out.
 */
export function verifyHeartbeatCertificate(bytes, { roundId = null, slot = null, committee, census, verify }) {
  let c; try { c = decodeHeartbeatCertificate(bytes); } catch (e) { return { ok: false, why: e.message }; }
  if (roundId && !sameBeat(c.roundId, keyBytesBeat(roundId))) return { ok: false, why: 'that heartbeat certificate names another round' };
  if (slot !== null && c.slot !== slot) return { ok: false, why: `that heartbeat certificate is for slot ${c.slot}, not ${slot}` };
  const members = new Set(committee.map(hexOfBeat));
  const inCensus = new Set(census.map(hexOfBeat));
  const signed = new Set(), heard = new Set();
  let leftOut = null;
  for (const g of c.groups) {
    if (!strictlySortedBeat(g.heard) || !strictlySortedBeat(g.leftOut) || !strictlySortedBeat(g.signatures.map((x) => x.nodePubkey)))
      return { ok: false, why: 'a heard list of that certificate is not sorted by node key, or names a node twice' };
    if (!g.signatures.length) return { ok: false, why: 'a heard list of that certificate is signed by nobody' };
    if (g.leftOut.some((k) => inCensus.has(toHex(k)))) return { ok: false, why: 'that certificate says the round\'s census left out a node the census holds' };
    const id = heardId({ roundId: c.roundId, slot: c.slot, heard: g.heard, leftOut: g.leftOut });
    for (const x of g.signatures) {
      const h = toHex(x.nodePubkey);
      if (!members.has(h)) return { ok: false, why: `${h.slice(0, 16)} signed who was heard at that slot and is not drawn for its committee` };
      if (signed.has(h)) return { ok: false, why: `member ${h.slice(0, 16)} signed two heard lists for that slot` };
      let good = false; try { good = verify(x.signature, id, x.nodePubkey); } catch { good = false; }
      if (!good) return { ok: false, why: `member ${h.slice(0, 16)}'s signature on who was heard does not verify` };
      signed.add(h);
    }
    for (const k of g.heard) heard.add(toHex(k));
    const lo = new Set(g.leftOut.map(toHex));
    leftOut = leftOut === null ? lo : new Set([...leftOut].filter((h) => lo.has(h)));
  }
  if (signed.size < HEARTBEAT_THRESHOLD)
    return { ok: false, why: `that heartbeat certificate is signed by ${signed.size} of the slot's committee, fewer than the ${HEARTBEAT_THRESHOLD} it needs` };
  for (const h of signed) heard.add(h);
  return { ok: true, roundId: c.roundId, slot: c.slot, signers: [...signed].sort(), heard: [...heard].sort(), leftOut: [...(leftOut || [])].sort() };
}

/**
 * A HEARTBEAT SLOT AS PROOF (presence.js): the certificate checked on the checker's own draw. Answers the record presence.js reads -
 * { roundId, role, closeMs, drawn (the committee), expected (the round's census), seated (the signers), present, leftOut } - or why not.
 */
export function provenHeartbeat(bytes, { roundId, slot, committee, census, closeMs, verify }) {
  const v = verifyHeartbeatCertificate(bytes, { roundId, slot, committee, census, verify });
  if (!v.ok) return v;
  return { ok: true, seating: { roundId: toHex(v.roundId), role: heartbeatRole(v.slot), closeMs: BigInt(closeMs), drawn: committee.map(hexOfBeat),
    expected: census.map(hexOfBeat), seated: v.signers, present: v.heard, leftOut: v.leftOut } };
}
