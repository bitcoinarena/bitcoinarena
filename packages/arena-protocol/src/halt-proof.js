// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT, PROVEN BY THE SEATS (spec §23A.5 "How a halt is proven, and what it slashes", RULED 2026-10-14 on the owner's delegation;
//). A federation that has lost 2f + 1 cannot sign for itself - rehearsal 17 measured it: with two of four guardians
// gone neither a HALTED record nor the second abandonment proof reached three signatures. So the census seats attest it:
//
//   HALT OBSERVATION  a seat's signed (federation_id, S, first_height, height, answering[]): it saw no guardian of the federation
//                     past session S from first_height to height, and these peers still answered their endpoint
//   HALT PROOF        observations by a majority of the census's active seats (never fewer than five), all naming the same S,
//                     each spanning abandon_blocks; voided by any evidence of a session after S. Halt height = the latest
//                     first_height among them. Every guardian of the record that a majority did not see answering is ABANDONED
//                     by the proof itself; one that answered through the halt is not slashed.
//
// NO CURVE: `sign(digest)` and `verify(signature, digest, nodePubkey)` are injected (BIP-340 over the seats' node keys).
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_HALT_OBSERVATION } from './constants.js';

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const is33 = (b) => b instanceof Uint8Array && b.length === 33;
const u32 = (h, what) => { if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) throw new Error(`${what} is a u32`); };
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
export const HALT_MIN_OBSERVERS = 5;

export function encodeHaltObservation(o) {
  if (!is32(o.federationId) || !is32(o.observer)) throw new Error('an observation names its federation (32) and its seat\'s node key (32)');
  u32(o.session, 'the last session'); u32(o.firstHeight, 'first_height'); u32(o.height, 'height');
  if (o.firstHeight > o.height) throw new Error('a halt cannot be first seen after the observation');
  const answering = o.answering || [];
  if (!answering.every(is33)) throw new Error('an answering peer is named by its 33-byte peer key');
  const w = new Writer();
  w.u8(TYPE_HALT_OBSERVATION); w.u16(PROTOCOL_VERSION);
  w.bytes32(o.federationId); w.u32(o.session); w.u32(o.firstHeight); w.u32(o.height);
  w.vec([...answering].sort(cmp), (k, ww) => ww.bytes(k, 33), { sortedBy: cmp });
  w.bytes32(o.observer);
  return w.finish();
}
export function decodeHaltObservation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_HALT_OBSERVATION) throw new Error('not a halt observation');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const o = { federationId: r.bytes32(), session: r.u32(), firstHeight: r.u32(), height: r.u32(), answering: r.vec((rr) => rr.bytes(33)), observer: r.bytes32() };
  r.end(); encodeHaltObservation(o); return o;
}
export const haltObservationId = (o) => taggedHash(TAG.haltObservation, encodeHaltObservation(o));
export const signHaltObservation = (o, sign) => ({ ...o, answering: [...(o.answering || [])].sort(cmp), signature: sign(haltObservationId(o)) });

/** How many of `seats` active census seats a halt proof needs: a majority, never fewer than HALT_MIN_OBSERVERS. */
export const haltQuorum = (seats) => Math.max(HALT_MIN_OBSERVERS, Math.floor(seats / 2) + 1);

/**
 * THE HALT PROOF (§23A.5). `observations`: signed halt observations; `record`: the federation's newest verified record (its
 * guardians by peer key); `censusSeats`: the node keys of the census's active seats; `abandonBlocks`; `verify`; `laterSession`:
 * the highest session any verified record or signed attestation names (null if none) - a session after S voids the proof.
 * Answers { ok, session, haltHeight, observers, abandoned: [peer key], answered: [peer key] } or { ok: false, why }.
 */
export function haltProof(observations, { record, censusSeats, abandonBlocks, verify, laterSession = null }) {
  const seats = new Set((censusSeats || []).map(toHex));
  const need = haltQuorum(seats.size);
  const bySession = new Map();
  const why = [];
  for (const o of observations || []) {
    try { encodeHaltObservation(o); } catch (e) { why.push(e.message); continue; }
    if (toHex(o.federationId) !== toHex(record.federationId)) continue;
    if (!seats.has(toHex(o.observer))) { why.push('an observer is not an active seat of the census'); continue; }
    if (o.height - o.firstHeight < abandonBlocks) { why.push(`an observation spans ${o.height - o.firstHeight} blocks, short of abandon_blocks ${abandonBlocks}`); continue; }
    if (!verify(o.signature, haltObservationId(o), o.observer)) { why.push('an observation is not signed by its seat'); continue; }
    const k = o.session;
    if (!bySession.has(k)) bySession.set(k, new Map());
    bySession.get(k).set(toHex(o.observer), o);            // one observation per seat and session
  }
  let best = null;
  for (const [session, m] of bySession) if (!best || m.size > best.m.size || (m.size === best.m.size && session > best.session)) best = { session, m };
  if (!best || best.m.size < need)
    return { ok: false, why: `${best ? best.m.size : 0} seat(s) observe the halt at one session, and ${seats.size} active seats need ${need}${why.length ? ` (${why[0]})` : ''}` };
  if (laterSession !== null && laterSession > best.session)
    return { ok: false, why: `session ${laterSession} is after the halted session ${best.session}: the federation is slow, not halted` };
  const set = [...best.m.values()];
  const haltHeight = Math.max(...set.map((o) => o.firstHeight));
  const seen = new Map();
  for (const o of set) for (const k of o.answering) seen.set(toHex(k), (seen.get(toHex(k)) || 0) + 1);
  const majority = Math.floor(set.length / 2) + 1;
  const abandoned = []; const answered = [];
  for (const g of record.guardians || []) ((seen.get(toHex(g.peerKey)) || 0) >= majority ? answered : abandoned).push(g.peerKey);
  return { ok: true, session: best.session, haltHeight, observers: set.length, abandoned, answered,
    id: taggedHash(TAG.haltObservation, Uint8Array.from(set.sort((a, b) => cmp(a.observer, b.observer)).flatMap((o) => [...haltObservationId(o)]))) };
}
