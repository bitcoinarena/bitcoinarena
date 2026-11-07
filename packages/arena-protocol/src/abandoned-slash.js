// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROM AN ABANDONED ROW TO A SLASH (spec §23A.5, RULED 2026-11-02, kanban #1058, #1059). The signed federation record is the filing, and a row with nothing left on the chain ends there. A row
// whose node still holds an output is slashed: the arbitration set, or from template 3 the census key's holders, read the row and act on that output.
// Without this a guardian could spend most of a bond, leave a little under the floor, and that remainder would walk free at maturity.
//
// ONE SLASH FORMAT (RULED 2026-11-02, kanban #1062): every slash commits to H(fraud_proof), so anyone can fetch the proof and re-check it. A proof_ref names evidence and an absence's names none
// that can be fetched, so the OP_RETURN carries the hash of an AbandonedProof, tagged as every slash proof is. Only rows with since_height at or above the network's ABANDONED_SLASH_HEIGHT act.
// Older ones stand as records and move no money.
//
// THE HASH COVERS THE COMPLETE PROOF (RULED 2026-11-03, kanban #1065, reversing #1064): the proof carries the signed record holding the row, signatures included. The bytes under the hash are the
// proof, so a checker fetches them from anyone and has one thing to judge. Two seats can hold one record under two signature sets, and so one output two hashes: a bond has one start, and the holders
// who signed it hold the bytes of the one that landed.
//
// `bonds` is everything one census read of a node's outputs: its entries and its exclusions (`bondsOf`). What a seat lists and what the set judges are the same few lines, so neither has a
// reading of its own. Pure: the chain, the curve and the record's signatures are the caller's.
import { GONE } from './federation-record.js';
import { bondSpentProof } from './absence.js';
import { guardianSlashStands, scheduledDeparture } from './federation-slash.js';
import { BOND_TEMPLATE_V3 } from './bond-script.js';
import { taggedHash, toHex } from './hash.js';
import { Writer, Reader } from './encode.js';
import { TAG, TYPE_ABANDONED_PROOF, PROTOCOL_VERSION, speaksVersion } from './constants.js';

const same = (a, b) => toHex(a) === toHex(b);
const hexOf = (x) => (x instanceof Uint8Array ? toHex(x) : String(x || '').toLowerCase());

/** One census read of what the chain holds of bonds: its entries and its exclusions, the under-the-floor outputs among them. */
export const bondsOf = (census) => [...((census && census.entries) || []), ...((census && census.excluded) || [])];

/**
 * The ABANDONED rows of a record that can be acted on: [{ peerKey, nodePubkey, sinceHeight, proofRef }]. A zero proof_ref names no proof, and a peer the record does not list names no node. `from`
 * the network's ABANDONED_SLASH_HEIGHT: an older row is not acted on, and null (a network that names no point) leaves none.
 */
export function abandonedRows(record, from) {
  const out = [];
  if (!Number.isInteger(from)) return out;
  for (const g of (record && record.gone) || []) {
    if (g.kind !== GONE.ABANDONED || !g.proofRef || g.proofRef.every((b) => b === 0) || g.sinceHeight < from) continue;
    const seat = (record.guardians || []).find((x) => same(x.peerKey, g.peerKey));
    if (seat) out.push({ peerKey: g.peerKey, nodePubkey: seat.nodePubkey, sinceHeight: g.sinceHeight, proofRef: g.proofRef });
  }
  return out;
}

/**
 * WHAT IS LEFT OF A NODE'S BOND: its outputs in `bonds` that no spend ended, confirmed at or before `sinceHeight`, ascending by outpoint. Money bonded after the offence stood for nothing at
 * the time of it, so it is not touched. A started output is out too: its slash is running, and the census reads its hold output as the bond. Answers [{ txid (hex), vout, sats, height,
 * template, advert, script }].
 */
export function outputsLeft(bonds, nodePubkey, sinceHeight) {
  const node = hexOf(nodePubkey), spent = new Set(), found = new Map();
  for (const b of bonds || []) {
    if (hexOf(b.pubkey || (b.advert && b.advert.nodePubkey)) !== node) continue;
    const key = `${hexOf(b.txid)}:${b.vout}`;
    if (b.spent || b.spentBy || b.hold) { spent.add(key); continue; }
    if (Number.isInteger(b.height) && b.height <= sinceHeight && b.advert && b.bondSats !== undefined && !found.has(key)) found.set(key, b);
  }
  return [...found.entries()].filter(([k]) => !spent.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, b]) => ({ txid: hexOf(b.txid), vout: b.vout, sats: BigInt(b.bondSats), height: b.height,
    template: b.advert.bondScriptTemplateVersion, advert: b.advert, ...(b.script ? { script: b.script } : {}) }));
}

/**
 * MAY THIS OUTPUT BE SLASHED ON THIS ROW. `record` the decoded record, already held to its threshold by the caller (the signed record is the filing); `nodePubkey` and `proofRef` what the proof
 * names, which the row must name too; `bonds` this reader's own census; `txid` (hex) and `vout` the output; `from` the network's ABANDONED_SLASH_HEIGHT. A row whose proof_ref is a spend this
 * census read is the chain's proof, checked here: that spend, of that node, at that height. Any other proof_ref is a filed absence, and it stands on the record's signatures: 2f + 1 guardians
 * signed the row, each having checked it (§23A.4). A notice was weighed when the row was written, so guardianSlashStands is asked of the proof alone. The holders of a census key ask this before
 * they sign a start, as the set does before path B. Answers { ok, slash, kind, why, proofRef, sinceHeight, nodePubkey, output, bondSpent }.
 */
export function abandonedSlashStands({ record, nodePubkey, proofRef, bonds, txid, vout, from }) {
  const row = abandonedRows(record, from).find((r) => same(r.nodePubkey, nodePubkey) && same(r.proofRef, proofRef));
  if (!row) return { ok: false, slash: false, why: 'that record has no ABANDONED row for that node and proof_ref from this network\'s slash height on' };
  const node = toHex(row.nodePubkey);
  const spend = (bonds || []).find((b) => b.spentBy && hexOf(b.pubkey) === node && b.spentBy.txid === toHex(row.proofRef) && b.spentBy.height === row.sinceHeight);
  const proof = spend ? bondSpentProof({ peerKey: row.peerKey, spent: spend.spentBy }) : { ok: true, peerKey: row.peerKey, sinceHeight: row.sinceHeight, signers: record.threshold, id: row.proofRef };
  // A SPEND AT OR AFTER THE OUTPUT'S MATURITY WAS A DEPARTURE ON SCHEDULE (#1318), not abandonment
  const stands = guardianSlashStands({ proof, scheduled: spend ? scheduledDeparture({ maturity: spend.advert && Number.isInteger(spend.advert.bondMaturityHeight) ? spend.advert.bondMaturityHeight : spend.maturity }) : null });
  if (!stands.ok || !stands.slash) return { ok: false, slash: false, why: stands.why };
  const output = outputsLeft(bonds, row.nodePubkey, row.sinceHeight).find((o) => o.txid === hexOf(txid) && o.vout === vout);
  if (!output) return { ok: false, slash: false, why: `${String(txid).slice(0, 16)}:${vout} is no output of that node left from before ${row.sinceHeight}` };
  return { ok: true, slash: true, kind: stands.kind, why: stands.why, proofRef: row.proofRef, sinceHeight: row.sinceHeight, nodePubkey: row.nodePubkey, output, bondSpent: !!spend };
}

/** 1 type + 2 version + federation + node + proof_ref + txid + a 4-byte vout, and then the signed record to the end. */
export const ABANDONED_PROOF_HEAD_BYTES = 135;

/** THE PROOF AN ABANDONMENT'S SLASH COMMITS TO: `txid` (internal order) and `vout` the output, `record` the signed federation record's bytes. Its id is the hash of these bytes, as for every slash proof. */
export function encodeAbandonedProof({ federationId, nodePubkey, proofRef, txid, vout, record }) {
  if (!(record instanceof Uint8Array) || !record.length) throw new Error('a proof of an abandonment carries its signed record');
  const w = new Writer();
  w.u8(TYPE_ABANDONED_PROOF);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(federationId);
  w.bytes32(nodePubkey);
  w.bytes32(proofRef);
  w.bytes32(txid);
  w.u32(vout);
  w.bytes(record, record.length);
  return w.finish();
}

export function decodeAbandonedProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ABANDONED_PROOF) throw new Error('not a proof of an abandonment');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { federationId: r.bytes32(), nodePubkey: r.bytes32(), proofRef: r.bytes32(), txid: r.bytes32(), vout: r.u32() };
  if (bytes.length <= ABANDONED_PROOF_HEAD_BYTES) throw new Error('a proof of an abandonment carries its signed record');
  return { ...p, record: bytes.subarray(ABANDONED_PROOF_HEAD_BYTES) };
}

/** Whether `bytes` is this kind of proof: a reader of proofs of every kind asks this first. */
export const isAbandonedProof = (bytes) => bytes instanceof Uint8Array && bytes[0] === TYPE_ABANDONED_PROOF;
/** The 32 bytes a slash's OP_RETURN commits to, of a proof's bytes. */
export const abandonedProofId = (bytes) => taggedHash(TAG.slashProof, bytes);

/** Who acts on an output: path B for templates 1 and 2, the census key's holders on a presig from template 3. */
export const startsByCensusKey = (template) => template === BOND_TEMPLATE_V3;
