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
import { taggedHash, toHex, fromHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_ABSENCE_ATTESTATION, TYPE_DEPARTURE_NOTICE } from './constants.js';
import { parseTransaction, commitmentsOf } from './tx.js';
import { splitBlock } from './block.js';

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
 * THE NOTICE IS ANCHORED ON CHAIN (ruled 2026-11-13, kanban #2600 / #2608, the backdating of #2599): posted_at is the guardian's own
 * word, so a notice signed at tip T with posted_at T - 432 let him leave at once and keep his bond. From the gate on a notice counts
 * from the height at which it is CONFIRMED on chain. posted_height is that block's height, read from the seat's own chain - never a
 * field the guardian writes - and leave_after >= posted_height + departure_notice. A notice with no anchor is no notice. A named block
 * hash is not an anchor (it proves "not before", and backdating needs "not after").
 *
 * ANCHORING IS PUBLISHING (kanban #2612, feedback #041, owner decision on option (c)): the anchor carries the WHOLE signed notice, not
 * its hash - one OP_RETURN "ARN" 'L' || notice (108) || signature (64), 176 bytes pushed with OP_PUSHDATA1 (a 179-byte script). With
 * only H(notice) on chain a guardian could anchor in secret at A with leave_after A + 432, keep serving, and show the notice at
 * A + 432: every seat took it as due at once and the period in which the federation founds a replacement was gone. Now every seat
 * reads the notice from the chain at the anchor's height (absences.js scanDepartures), so the period starts when the federation can
 * see it. A transaction that carries only the hash (the #2608 form, never posted) anchors nothing. Standard and relayed by Bitcoin Core
 * 30 and later (-datacarriersize 100000 by default; measured with testmempoolaccept on regtest Core 31.1); consensus has no limit, so a
 * seat on any version reads it in a block.
 *
 * THE GATE: a record judged at or above its network's DEPARTURE_ANCHOR_HEIGHT reads notices anchored; below it, the old rule byte for
 * byte (posted_at as written, its residual standing). Beside the ballot's BALLOT_BIND_HEIGHT (ballot.js): regtest from 0, mainnet from
 * its first block, testnet4 about 600 blocks above the tip of 2026-11-13 (~161 011): 161 600.
 */
export const DEPARTURE_ANCHOR_HEIGHT = Object.freeze({ regtest: 0, testnet4: 161600, mainnet: 0 });
/** The gate of a network by name ('regtest' | 'testnet4'); any other network is read as mainnet (anchored from its first block). */
export const departureAnchorHeight = (network) => (Object.prototype.hasOwnProperty.call(DEPARTURE_ANCHOR_HEIGHT, network) ? DEPARTURE_ANCHOR_HEIGHT[network] : DEPARTURE_ANCHOR_HEIGHT.mainnet);
/** Whether a notice judged at `height` must be anchored under `gate` (no gate given: never, the old rule). */
export const anchorRequired = (gate, height) => Number.isInteger(gate) && Number.isInteger(height) && height >= gate;
/** The blocks a leaving node adds to leave_after for its anchor to confirm in (absence-producer.js): one day. */
export const DEPARTURE_ANCHOR_SLACK = 144;
export const DEPARTURE_ANCHOR_MARKER = Uint8Array.from([0x41, 0x52, 0x4e, 0x4c]);     // "ARN" 'L'
export const DEPARTURE_NOTICE_BYTES = 1 + 2 + 32 + 33 + 4 + 4 + 32;
export const DEPARTURE_ANCHOR_BYTES = 4 + DEPARTURE_NOTICE_BYTES + 64;                   // 176
/** The anchor's payload for a signed notice: "ARN" 'L' || notice || signature - and the OP_RETURN script that pushes it. */
export function encodeDepartureAnchor(d) {
  if (!(d && d.signature instanceof Uint8Array && d.signature.length === 64)) throw new Error('an anchor carries the signed notice: its 64-byte signature with it');
  const out = new Uint8Array(DEPARTURE_ANCHOR_BYTES);
  out.set(DEPARTURE_ANCHOR_MARKER, 0); out.set(encodeDeparture(d), 4); out.set(d.signature, 4 + DEPARTURE_NOTICE_BYTES);
  return out;
}
export const departureAnchorScript = (d) => Uint8Array.from([0x6a, 0x4c, DEPARTURE_ANCHOR_BYTES, ...encodeDepartureAnchor(d)]);
/** The signed notice an anchor payload carries, or null (another payload, the hash-only form, bytes that are no notice). */
export function decodeDepartureAnchor(p) {
  if (!(p instanceof Uint8Array) || p.length !== DEPARTURE_ANCHOR_BYTES) return null;
  for (let i = 0; i < 4; i++) if (p[i] !== DEPARTURE_ANCHOR_MARKER[i]) return null;
  try { return { ...decodeDeparture(p.slice(4, 4 + DEPARTURE_NOTICE_BYTES)), signature: p.slice(4 + DEPARTURE_NOTICE_BYTES) }; } catch { return null; }
}
const txidOf = (tx) => toHex(Uint8Array.from(tx.txid).reverse());
/** Every notice a parsed transaction carries in its outputs (its signature not checked here). */
export const departuresOfTx = (tx) => commitmentsOf(tx).map(decodeDepartureAnchor).filter(Boolean);
/** Every notice in a raw block, with its transaction's id and the block's height: what a seat reads off its chain (absences.js). */
export function departuresInBlock(raw, height) {
  const out = [];
  for (const t of splitBlock(raw).transactions) {
    let tx; try { tx = parseTransaction(t); } catch { continue; }
    for (const notice of departuresOfTx(tx)) out.push({ notice, txid: txidOf(tx), height });
  }
  return out;
}
/**
 * A NOTICE'S ANCHOR, READ OFF ITS TRANSACTION: `raw` a transaction confirmed at `height` on the seat's own chain (the caller reads it
 * there: getrawtransaction with the block hash, the block on the main chain - as a ballot deposit is read). The transaction must carry
 * the notice's own bytes (kanban #2612); its hash alone is no anchor. Answers { ok, postedHeight, txid, signature } - the signature as
 * the chain carries it, the one the seat checks - or why not.
 */
export function departureAnchorOf({ raw, height, notice }) {
  let tx; try { tx = parseTransaction(raw); } catch (e) { return { ok: false, why: `that is no transaction: ${e.message}` }; }
  if (!Number.isInteger(height) || height < 0) return { ok: false, why: 'an anchor counts once it is confirmed at a height' };
  let want; try { want = toHex(encodeDeparture(notice)); } catch (e) { return { ok: false, why: e.message }; }
  const found = departuresOfTx(tx).find((n) => toHex(encodeDeparture(n)) === want);
  if (!found) return { ok: false, why: 'that transaction does not carry this notice in an "ARN" \'L\' anchor' };
  return { ok: true, postedHeight: height, txid: txidOf(tx), signature: found.signature };
}

/**
 * A DEPARTURE NOTICE THAT STANDS (§23A.5): signed by the leaving guardian's own node key, for a guardian of the record, with
 * leave_after at least departure_notice blocks after it was posted. Answers { ok, peerKey, leaveAfterHeight, postedHeight } or why not.
 * ANCHORED (kanban #2608): judged at `height` at or above `gate`, "posted" is `anchorHeight` - the confirmed height of its "ARN" 'L'
 * anchor on the seat's chain, at or below `height` - and a notice without one does not stand. Below the gate (or no gate): posted_at.
 */
export function departureStands(d, { record, departureNotice, verify, height: at = null, gate = null, anchorHeight = null }) {
  try { encodeDeparture(d); } catch (e) { return { ok: false, why: e.message }; }
  if (toHex(d.federationId) !== toHex(record.federationId)) return { ok: false, why: 'that notice names another federation' };
  const g = guardianOf(record, d.peerKey);
  if (!g) return { ok: false, why: 'that peer is not a guardian of this federation' };
  if (toHex(g.nodePubkey) !== toHex(d.nodePubkey)) return { ok: false, why: 'the notice names another node key than the record has for that peer' };
  if (!verify(d.signature, departureId(d), d.nodePubkey)) return { ok: false, why: 'the notice is not signed by the leaving guardian\'s node key' };
  let posted = d.postedAt;
  if (anchorRequired(gate, at)) {
    if (!Number.isInteger(anchorHeight)) return { ok: false, why: `no "ARN" 'L' anchor of that notice is confirmed on this seat's chain: from height ${gate} a notice counts only from its anchor` };
    if (anchorHeight > at) return { ok: false, why: `its anchor confirmed at ${anchorHeight}, after the height ${at} it is judged at` };
    posted = anchorHeight;
  }
  if (d.leaveAfterHeight < posted + departureNotice) return { ok: false, why: `leave_after ${d.leaveAfterHeight} is less than departure_notice (${departureNotice} blocks) after it was posted at ${posted}${posted !== d.postedAt ? ' (its anchor\'s height)' : ''}` };
  return { ok: true, peerKey: d.peerKey, leaveAfterHeight: d.leaveAfterHeight, postedHeight: posted };
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

/**
 * A BOND SPENT WHILE SEATED (§23A.5, kanban #1054): "the census sees it", so this proof is the chain's and needs no attestation. `spent` { txid (hex), height }, the census's own reading of what
 * ended the bond; a slash start is not such a spend, since its hold output stays the bond. The peer is gone since that height and the proof is that transaction: proof_ref its txid.
 * Answers what abandonmentProof answers, for guardianSlashStands.
 */
export function bondSpentProof({ peerKey, spent }) {
  if (!spent || !Number.isInteger(spent.height) || !/^[0-9a-f]{64}$/.test(String(spent.txid))) return { ok: false, why: 'no spend of that bond was read' };
  return { ok: true, peerKey, sinceHeight: spent.height, signers: 0, bondSpent: true, id: fromHex(spent.txid) };
}
