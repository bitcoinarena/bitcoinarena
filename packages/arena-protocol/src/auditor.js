// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND'S AUDITORS (spec §13A.1, kanban #725, protocol 22): about three census nodes outside a round's committees, drawn in
// secret by a VRF over the round id, replay every run of the round and publish an AUDIT ("checked, it matches") or the objection of
// §13A. FINAL does not wait for them; 10 % of the nodes' fee, after the website's line, goes to the auditors whose AUDIT arrived in time.
//
//   WHO MAY    the census at the round's census_height advertising `audit`, less every node drawn for the round's roles and the
//              nodes and operators of its players (auditEligible)
//   THE DRAW   alpha = H_tag(ARENA/v1/Auditor, round_id); (beta, pi) = ECVRF(node secret, alpha); auditor iff
//              int(beta[0..8]) / 2^64 < AUDITORS x weight / W (isAuditor) - in integers, never a fraction
//   THE AUDIT  (round_id, results_hash, node_pubkey, pi), signed by the node key under ARENA/v1/Audit (encodeAudit, auditId)
//   THE PAY    auditorShares: floor(nodes' part after the website x 10 %), equally over the valid AUDITs; the rest to the pools
//
// NO CURVE: the VRF (vrf.js makeVrf) and `verify(signature, digest, pubkey)` (BIP-340) are injected, as everywhere here.
// A node key is x-only (BIP-340); its VRF key is the even-y point 02 || x, and its VRF secret the node secret or its negation.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_AUDIT } from './constants.js';
import { weightOf } from './sortition.js';

export const AUDITORS = 3n;
/** The auditors' share of the nodes' part of the fee, after the website's line (§13A.1, RULED 2026-10-27: 10 %). */
export const AUDIT_SHARE_BPS = 1000n;
export const AUDIT_PROOF_BYTES = 81;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const beInt = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** The VRF input of a round's draw: fixed by the round id, before any result exists. */
export const auditAlpha = (roundId) => {
  if (!is32(roundId)) throw new Error('an audit draw is over a 32-byte round id');
  return taggedHash(TAG.auditor, roundId);
};

/** A node's VRF public key: its x-only key as the even-y point. */
export const vrfPublicKey = (nodePubkey) => {
  if (!is32(nodePubkey)) throw new Error('a node key is 32 bytes (x-only)');
  const out = new Uint8Array(33); out[0] = 0x02; out.set(nodePubkey, 1); return out;
};

/** A node's VRF secret: its node secret, negated when that gives the odd-y point (BIP-340's rule), so it proves under vrfPublicKey. */
export function vrfSecretFor(secret, Point) {
  const q = Point.Fn.ORDER;
  const x = typeof secret === 'bigint' ? secret : beInt(secret);
  const y = Point.BASE.multiply(x).toBytes(true)[0];
  return y === 0x02 ? x : q - x;
}

/**
 * WHO MAY AUDIT A ROUND: `entries` the census at its census_height, `drawn` the node keys (hex) drawn for any of its roles (all of
 * them, seated or not), `players` the node keys (hex) of its players' nodes and `operators` their operator ids. One node key is one
 * auditor: its bonds summed, as in a committee draw. Answers { eligible: Map(keyHex -> weight BigInt), total: W }.
 */
export function auditEligible({ entries, bondMinSats, drawn = [], players = [], operators = [] }) {
  if (typeof bondMinSats !== 'bigint' || bondMinSats <= 0n) throw new Error('an audit draw weighs against a positive bond floor');
  const out = new Set([...drawn, ...players].map((k) => String(k).toLowerCase()));
  const ops = new Set(operators.map(String));
  const sats = new Map();
  for (const e of entries || []) {
    if (!(e.roles || []).includes('audit')) continue;
    const key = toHex(e.pubkey);
    if (out.has(key) || (e.operatorId !== undefined && ops.has(String(e.operatorId)))) continue;
    sats.set(key, (sats.get(key) || 0n) + BigInt(e.bondSats));
  }
  const eligible = new Map();
  let total = 0n;
  for (const [key, s] of sats) { if (s < bondMinSats) continue; const w = weightOf(s, bondMinSats); eligible.set(key, w); total += w; }
  return { eligible, total };
}

/** Whether a VRF output draws its node: int(beta[0..8]) x W < AUDITORS x weight x 2^64, all in integers. */
export function isAuditor({ beta, weight, total }) {
  if (!(beta instanceof Uint8Array) || beta.length < 8) throw new Error('a VRF output is at least 8 bytes');
  if (typeof weight !== 'bigint' || typeof total !== 'bigint' || weight <= 0n || total <= 0n) return false;
  return beInt(beta.subarray(0, 8)) * total < AUDITORS * weight * (1n << 64n);
}

/**
 * THE RESULTS AN AUDIT VOUCHES FOR: H_tag(ARENA/v1/AuditResults, n || (entry_id 32, result digest 32)*), in entry id order - the
 * provisional results of every entry of the round, each as the 32-byte digest of its signed result.
 */
export function auditResultsHash(results) {
  const rows = (results || []).map((r) => {
    if (!is32(r.entryId) || !is32(r.resultDigest)) throw new Error('an audited result is (32-byte entry id, 32-byte result digest)');
    return r;
  }).sort((a, b) => (toHex(a.entryId) < toHex(b.entryId) ? -1 : 1));
  const w = new Writer();
  w.u32(rows.length);
  for (const r of rows) { w.bytes32(r.entryId); w.bytes32(r.resultDigest); }
  return taggedHash(TAG.auditResults, w.finish());
}

export function encodeAudit(a) {
  if (!is32(a.roundId) || !is32(a.resultsHash) || !is32(a.nodePubkey)) throw new Error('an AUDIT names a round, its results and its node (32 bytes each)');
  if (!(a.vrfProof instanceof Uint8Array) || a.vrfProof.length !== AUDIT_PROOF_BYTES) throw new Error(`an AUDIT carries its ${AUDIT_PROOF_BYTES}-byte VRF proof`);
  const w = new Writer();
  w.u8(TYPE_AUDIT); w.u16(PROTOCOL_VERSION);
  w.bytes32(a.roundId); w.bytes32(a.resultsHash); w.bytes32(a.nodePubkey); w.bytes(a.vrfProof, AUDIT_PROOF_BYTES);
  return w.finish();
}

export function decodeAudit(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_AUDIT) throw new Error('not an AUDIT');
  r.u16();
  const a = { roundId: r.bytes32(), resultsHash: r.bytes32(), nodePubkey: r.bytes32(), vrfProof: r.bytes(AUDIT_PROOF_BYTES) };
  r.end();
  return a;
}

/** What the node key signs. */
export const auditId = (a) => taggedHash(TAG.audit, encodeAudit(a));

/**
 * A SEAT'S CHECK OF ONE AUDIT (§13A.1 "A settlement seat counts an AUDIT only if"): signed by its node, its VRF proof good for the
 * round under that node's key, the node eligible and drawn, and its results hash the one being settled. The arrival time is the
 * seat's to check (signed times, §13A rule 3). Answers { ok, beta } or { ok: false, why }.
 */
export function auditStands(a, { signature, vrf, verify, eligible, total, resultsHash }) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return { ok: false, why: 'an AUDIT is signed (64 bytes)' };
  if (!verify(signature, auditId(a), a.nodePubkey)) return { ok: false, why: 'the AUDIT is not signed by the node it names' };
  const key = toHex(a.nodePubkey);
  const weight = eligible.get(key);
  if (!weight) return { ok: false, why: 'that node may not audit this round (not in its eligible set)' };
  const beta = vrf.verify(vrfPublicKey(a.nodePubkey), auditAlpha(a.roundId), a.vrfProof);
  if (!beta) return { ok: false, why: 'the VRF proof does not verify for that node and round' };
  if (!isAuditor({ beta, weight, total })) return { ok: false, why: 'that node was not drawn to audit this round' };
  if (resultsHash && toHex(resultsHash) !== toHex(a.resultsHash)) return { ok: false, why: 'the AUDIT vouches for other results than these' };
  return { ok: true, beta };
}

/**
 * THE AUDITORS' LINE (§13A.1 "Pay"): `nodesMsat` the nodes' part of the fee after the website's line, `auditors` the node keys
 * whose AUDIT stood at final_after. Answers { each: [{ key, msat }], backMsat } - backMsat stays in the pools.
 */
export function auditorShares({ nodesMsat, auditors }) {
  if (typeof nodesMsat !== 'bigint' || nodesMsat < 0n) throw new Error('the nodes\' part is a BigInt of msat');
  const keys = [...new Set((auditors || []).map((k) => String(k).toLowerCase()))].sort();
  const share = (nodesMsat * AUDIT_SHARE_BPS) / 10000n;
  if (!keys.length) return { each: [], backMsat: nodesMsat };
  const one = share / BigInt(keys.length);
  return { each: keys.map((key) => ({ key, msat: one })), backMsat: nodesMsat - one * BigInt(keys.length) };
}
