// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN WHO IS GONE, AND ONE WHO LEAVES (spec §23A.4-§23A.5), the first slice: the signed objects and their
// checks. Producing an attestation needs a guardian's per-peer consensus view (the fork's API) and is the next slice.
//
//   ABSENCE ATTESTATION  each guardian signs, once a day while it lasts, (federation_id, peer, last_seen_height, height) for
//                        every peer it has not seen in consensus
//   ABANDONMENT PROOF    2f + 1 of them, by distinct guardians of the record, agreeing on a peer for at least abandon_blocks:
//                        portable, verifiable from the record's keys - the fraud proof §5A.3B's arbitration set slashes on
//   DEPARTURE NOTICE     the peer's own signed (federation_id, peer, leave_after_height), leave_after >= now + departure_notice:
//                        recorded DEPARTED, and his bond untouched (RULED 2026-09-21: "Leaving is legitimate")
//
// NO CURVE: `sign(digest)` and `verify(signature, digest, nodePubkey)` are injected (BIP-340 over node keys). A peer is named
// by its 33-byte Fedimint peer key, a signer by its node key - both as the federation record lists its guardians.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_ABSENCE_ATTESTATION, TYPE_DEPARTURE_NOTICE } from './constants.js';

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const is33 = (b) => b instanceof Uint8Array && b.length === 33;
const height = (h, what) => { if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) throw new Error(`${what} is a block height`); };

export function encodeAbsence(a) {
  if (!is32(a.federationId) || !is33(a.peerKey) || !is32(a.attester)) throw new Error('an attestation names its federation (32), the absent peer (33) and its attester\'s node key (32)');
  height(a.lastSeenHeight, 'last_seen_height'); height(a.height, 'height');
  if (a.lastSeenHeight > a.height) throw new Error('a peer cannot be last seen after the attestation');
  const w = new Writer();
  w.u8(TYPE_ABSENCE_ATTESTATION); w.u16(PROTOCOL_VERSION);
  w.bytes32(a.federationId); w.bytes(a.peerKey, 33); w.u32(a.lastSeenHeight); w.u32(a.height); w.bytes32(a.attester);
  return w.finish();
}
export function decodeAbsence(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ABSENCE_ATTESTATION) throw new Error('not an absence attestation');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const a = { federationId: r.bytes32(), peerKey: r.bytes(33), lastSeenHeight: r.u32(), height: r.u32(), attester: r.bytes32() };
  r.end(); encodeAbsence(a); return a;
}
export const absenceId = (a) => taggedHash(TAG.absenceAttestation, encodeAbsence(a));
export const signAbsence = (a, sign) => ({ ...a, signature: sign(absenceId(a)) });

export function encodeDeparture(d) {
  if (!is32(d.federationId) || !is33(d.peerKey) || !is32(d.nodePubkey)) throw new Error('a notice names its federation (32), the leaving peer (33) and his node key (32)');
  height(d.leaveAfterHeight, 'leave_after_height'); height(d.postedAt, 'the height it was posted at');
  const w = new Writer();
  w.u8(TYPE_DEPARTURE_NOTICE); w.u16(PROTOCOL_VERSION);
  w.bytes32(d.federationId); w.bytes(d.peerKey, 33); w.u32(d.leaveAfterHeight); w.u32(d.postedAt); w.bytes32(d.nodePubkey);
  return w.finish();
}
export function decodeDeparture(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DEPARTURE_NOTICE) throw new Error('not a departure notice');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const d = { federationId: r.bytes32(), peerKey: r.bytes(33), leaveAfterHeight: r.u32(), postedAt: r.u32(), nodePubkey: r.bytes32() };
  r.end(); encodeDeparture(d); return d;
}
export const departureId = (d) => taggedHash(TAG.departureNotice, encodeDeparture(d));
export const signDeparture = (d, sign) => ({ ...d, signature: sign(departureId(d)) });

const guardianOf = (record, peerKey) => (record.guardians || []).find((g) => toHex(g.peerKey) === toHex(peerKey)) || null;
const byNode = (record, nodePubkey) => (record.guardians || []).find((g) => toHex(g.nodePubkey) === toHex(nodePubkey)) || null;

/**
 * A DEPARTURE NOTICE THAT STANDS (§23A.5): signed by the leaving guardian's own node key, for a guardian of the record, with
 * leave_after at least departure_notice blocks after it was posted. Answers { ok, peerKey, leaveAfterHeight } or why not.
 */
export function departureStands(d, { record, departureNotice, verify }) {
  try { encodeDeparture(d); } catch (e) { return { ok: false, why: e.message }; }
  if (toHex(d.federationId) !== toHex(record.federationId)) return { ok: false, why: 'that notice names another federation' };
  const g = guardianOf(record, d.peerKey);
  if (!g) return { ok: false, why: 'that peer is not a guardian of this federation' };
  if (toHex(g.nodePubkey) !== toHex(d.nodePubkey)) return { ok: false, why: 'the notice names another node key than the record has for that peer' };
  if (!verify(d.signature, departureId(d), d.nodePubkey)) return { ok: false, why: 'the notice is not signed by the leaving guardian\'s node key' };
  if (d.leaveAfterHeight < d.postedAt + departureNotice) return { ok: false, why: `leave_after ${d.leaveAfterHeight} is less than departure_notice (${departureNotice} blocks) after it was posted at ${d.postedAt}` };
  return { ok: true, peerKey: d.peerKey, leaveAfterHeight: d.leaveAfterHeight };
}

/**
 * AN ABANDONMENT PROOF (§23A.4): from `attestations`, those signed by distinct guardians of `record` (never the absent peer) about
 * one peer whose absence lasts at least `abandonBlocks` (height - last_seen_height); at the record's threshold (2f + 1) it stands.
 * The peer is gone since the latest last_seen any of them names. Answers { ok, peerKey, sinceHeight, signers, id } or why not.
 */
export function abandonmentProof(attestations, { record, peerKey, abandonBlocks, verify }) {
  if (!guardianOf(record, peerKey)) return { ok: false, why: 'that peer is not a guardian of this federation' };
  const counted = new Map();                      // attester node key hex -> attestation
  const why = [];
  for (const a of attestations || []) {
    try { encodeAbsence(a); } catch (e) { why.push(e.message); continue; }
    if (toHex(a.federationId) !== toHex(record.federationId) || toHex(a.peerKey) !== toHex(peerKey)) continue;
    const g = byNode(record, a.attester);
    if (!g) { why.push('an attester is not a guardian of this federation'); continue; }
    if (toHex(g.peerKey) === toHex(peerKey)) { why.push('the absent peer cannot attest its own absence'); continue; }
    if (a.height - a.lastSeenHeight < abandonBlocks) { why.push(`an attestation spans ${a.height - a.lastSeenHeight} blocks, short of abandon_blocks ${abandonBlocks}`); continue; }
    if (!verify(a.signature, absenceId(a), a.attester)) { why.push('an attestation is not signed by its attester'); continue; }
    if (!counted.has(toHex(a.attester))) counted.set(toHex(a.attester), a);
  }
  const need = record.threshold;
  if (counted.size < need) return { ok: false, why: `${counted.size} guardian(s) attest the absence, the threshold is ${need}${why.length ? ` (${why[0]})` : ''}` };
  const set = [...counted.values()].sort((x, y) => (toHex(x.attester) < toHex(y.attester) ? -1 : 1));
  const sinceHeight = Math.max(...set.map((a) => a.lastSeenHeight));
  const id = taggedHash(TAG.abandonmentProof, Uint8Array.from(set.flatMap((a) => [...absenceId(a)])));
  return { ok: true, peerKey, sinceHeight, signers: set.length, id, attestations: set };
}
