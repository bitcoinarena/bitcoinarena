// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROM AN ABANDONED ROW TO A SLASH (spec §23A.5, RULED 2026-11-02, kanban #1058, #1059). The signed federation record is the filing, and a row with nothing left on the chain ends there. A row
// whose node still holds an output is slashed: the arbitration set, or from template 3 the census key's holders, read the row and act on that output, on the row's proof_ref.
// Without this a guardian could spend most of a bond, leave a little under the floor, and that remainder would walk free at maturity.
//
// `bonds` is everything one census read of a node's outputs: its entries and its exclusions (`bondsOf`). What a seat lists and what the set judges are the same few lines, so neither has a
// reading of its own. Pure: the chain, the curve and the record's signatures are the caller's.
import { GONE } from './federation-record.js';
import { bondSpentProof } from './absence.js';
import { guardianSlashStands } from './federation-slash.js';
import { BOND_TEMPLATE_V3 } from './bond-script.js';
import { taggedHash, toHex, fromHex } from './hash.js';

const same = (a, b) => toHex(a) === toHex(b);
const hexOf = (x) => (x instanceof Uint8Array ? toHex(x) : String(x || '').toLowerCase());

/** One census read of what the chain holds of bonds: its entries and its exclusions, the under-the-floor outputs among them. */
export const bondsOf = (census) => [...((census && census.entries) || []), ...((census && census.excluded) || [])];

/** The ABANDONED rows of a record that can be acted on: [{ peerKey, nodePubkey, sinceHeight, proofRef }]. A zero proof_ref names no proof, and a peer the record does not list names no node. */
export function abandonedRows(record) {
  const out = [];
  for (const g of (record && record.gone) || []) {
    if (g.kind !== GONE.ABANDONED || !g.proofRef || g.proofRef.every((b) => b === 0)) continue;
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

/** The name one row's slash of one output goes by, in a seat's listing and the set's state: a row can leave several outputs, and each is its own transaction. Nothing on the chain carries it. */
export const abandonedSlashId = ({ proofRef, txid, vout }) => taggedHash('ARENA/v1/AbandonedSlash', Uint8Array.from([...proofRef, ...fromHex(txid), vout & 255, (vout >>> 8) & 255, (vout >>> 16) & 255, vout >>> 24]));

/**
 * MAY THIS OUTPUT BE SLASHED ON THIS ROW. `record` the decoded record, already held to its threshold by the caller (the signed record is the filing); `peerKey` the row's peer; `bonds` this
 * reader's own census; `txid` (hex) and `vout` the output. A row whose proof_ref is a spend this census read is the chain's proof, checked here: that spend, of that node, at that height.
 * Any other proof_ref is a filed absence, and it stands on the record's signatures: 2f + 1 guardians signed the row, each having checked it (§23A.4). A notice was weighed when the row was
 * written, so guardianSlashStands is asked of the proof alone. The holders of a census key ask this before they sign a start, as the set does before path B.
 * Answers { ok, slash, kind, why, proofRef, sinceHeight, nodePubkey, output, bondSpent }.
 */
export function abandonedSlashStands({ record, peerKey, bonds, txid, vout }) {
  const row = abandonedRows(record).find((r) => same(r.peerKey, peerKey));
  if (!row) return { ok: false, slash: false, why: 'that record has no ABANDONED row for that peer' };
  const node = toHex(row.nodePubkey);
  const spend = (bonds || []).find((b) => b.spentBy && hexOf(b.pubkey) === node && b.spentBy.txid === toHex(row.proofRef) && b.spentBy.height === row.sinceHeight);
  const proof = spend ? bondSpentProof({ peerKey: row.peerKey, spent: spend.spentBy }) : { ok: true, peerKey: row.peerKey, sinceHeight: row.sinceHeight, signers: record.threshold, id: row.proofRef };
  const stands = guardianSlashStands({ proof });
  if (!stands.ok || !stands.slash) return { ok: false, slash: false, why: stands.why };
  const output = outputsLeft(bonds, row.nodePubkey, row.sinceHeight).find((o) => o.txid === hexOf(txid) && o.vout === vout);
  if (!output) return { ok: false, slash: false, why: `${String(txid).slice(0, 16)}:${vout} is no output of that node left from before ${row.sinceHeight}` };
  return { ok: true, slash: true, kind: stands.kind, why: stands.why, proofRef: row.proofRef, sinceHeight: row.sinceHeight, nodePubkey: row.nodePubkey, output, bondSpent: !!spend };
}

/** Who acts on an output: path B for templates 1 and 2, the census key's holders on a presig from template 3. */
export const startsByCensusKey = (template) => template === BOND_TEMPLATE_V3;
