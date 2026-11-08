// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SIGNING A SPENT-SET COPY ABOVE THE HALT'S BOUND (§5A.3 offence row, RULED 2026-11-07 on #1262, kanban #1269): "Signing a spent-set or issued-set copy naming
// a session above the halt's bound; proof: the signed copy + the halt proof; Template-3 path; the guardian's own bond." The halt's bound is the halt proof's
// session + 1 (spent-set.js: no session above it is read) - a copy naming a session the consensus never reached is a lie its signer cannot take back.
// Omitting a nonce is NOT an offence (not provable without the consensus history; the n - t + 1 rule covers it). No issued-set copy is signed anywhere yet:
// when one is, it joins here as a second kind.
//
//   PROOF  TYPE_BOUND_PROOF, version, federation_id, node key, bond txid (internal order) + vout, the signed record that seats the guardian, the signed copy
//          (encodeSpentSet || signature 64), the halt observations (each encodeHaltObservation || signature 64). Its id is TAG.slashProof over the bytes.
//   STANDS the copy stands against the record (spent-set.js spentSetStands: a guardian of it signed it), its signer is the accused, the observations make a halt
//          proof on the checker's census (halt-proof.js haltProof), the copy's session > that proof's session + 1, and the accused's template-3 output is left.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_BOUND_PROOF, PROTOCOL_VERSION, speaksVersion } from './constants.js';
import { encodeSpentSet, decodeSpentSet, spentSetStands } from './spent-set.js';
import { encodeHaltObservation, decodeHaltObservation, haltProof } from './halt-proof.js';
import { theftTakes, theftOutputs } from './theft-slash.js';

const SIG = 64;
const varBytes = (w, b) => { w.u32(b.length); w.bytes(b); };
const readVarBytes = (r) => r.bytes(r.u32());
const signed = (body, signature) => { if (!(signature instanceof Uint8Array) || signature.length !== SIG) throw new Error('a signature is 64 bytes'); return Uint8Array.from([...body, ...signature]); };
const split = (bytes) => ({ body: bytes.subarray(0, bytes.length - SIG), signature: bytes.subarray(bytes.length - SIG) });

/** `copy` a signed spent-set copy ({ ...fields, signature }); `observations` signed halt observations; `record` the signed record's bytes. */
export function encodeBoundProof({ federationId, nodePubkey, txid, vout, record, copy, observations }) {
  if (!(record instanceof Uint8Array) || !record.length) throw new Error('a bound proof carries the signed record that seats the guardian');
  if (!Array.isArray(observations) || !observations.length) throw new Error('a bound proof carries the halt observations its halt proof is made of');
  const w = new Writer();
  w.u8(TYPE_BOUND_PROOF); w.u16(PROTOCOL_VERSION);
  w.bytes32(federationId); w.bytes32(nodePubkey); w.bytes32(txid); w.u32(vout);
  varBytes(w, record);
  varBytes(w, signed(encodeSpentSet(copy), copy.signature));
  w.u32(observations.length);
  for (const o of observations) varBytes(w, signed(encodeHaltObservation(o), o.signature));
  return w.finish();
}
export function decodeBoundProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_BOUND_PROOF) throw new Error('not a proof of a copy above the halt\'s bound');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { federationId: r.bytes32(), nodePubkey: r.bytes32(), txid: r.bytes32(), vout: r.u32(), record: readVarBytes(r) };
  const c = split(readVarBytes(r));
  p.copy = { ...decodeSpentSet(c.body), signature: c.signature };
  const n = r.u32(); p.observations = [];
  for (let i = 0; i < n; i++) { const o = split(readVarBytes(r)); p.observations.push({ ...decodeHaltObservation(o.body), signature: o.signature }); }
  r.end();
  if (!p.record.length || !n) throw new Error('a bound proof carries its record and its halt observations');
  return p;
}
export const isBoundProof = (bytes) => bytes instanceof Uint8Array && bytes[0] === TYPE_BOUND_PROOF;
export const boundProofId = (bytes) => taggedHash(TAG.slashProof, bytes);
const same = (a, b) => toHex(a) === toHex(b);

/**
 * MAY THIS OUTPUT BE SLASHED FOR THIS COPY, on one checker's own reads. `record` the proof's record, already held to its threshold on the checker's census; `proof`
 * decoded; `censusSeats` the node keys of the checker's census's active seats; `abandonBlocks`; `laterSession` (haltProof's: a later session voids the halt);
 * `bonds`, `atHeight` the checker's census read. Answers { verdict, why, output?, bound? } - false where the copy is inside the bound or the halt is not proven.
 */
export function boundSlashStands({ record, proof, verify, censusSeats, abandonBlocks, laterSession = null, bonds, atHeight }) {
  if (!same(record.federationId, proof.federationId) || !same(proof.copy.federationId, proof.federationId)) return { verdict: false, why: 'that record or copy is another federation\'s' };
  if (!same(proof.copy.signer, proof.nodePubkey)) return { verdict: false, why: 'the copy is not signed by the guardian the proof accuses' };
  if (!theftTakes(record).some((k) => same(k, proof.nodePubkey))) return { verdict: false, why: 'that record does not seat that node as a guardian' };
  const st = spentSetStands(proof.copy, { record, verify });
  if (!st.ok) return { verdict: false, why: st.why };
  const halt = haltProof(proof.observations, { record, censusSeats, abandonBlocks, verify, laterSession });
  if (!halt.ok) return { verdict: false, why: `no halt proven: ${halt.why}` };
  const bound = halt.session + 1;
  if (!(proof.copy.session > bound)) return { verdict: false, why: `the copy names session ${proof.copy.session}, within the halt's bound ${bound}`, bound };
  const output = theftOutputs(bonds, proof.nodePubkey, atHeight).find((o) => o.txid === toHex(proof.txid) && o.vout === proof.vout);
  if (!output) return { verdict: false, why: `${toHex(proof.txid).slice(0, 16)}:${proof.vout} is no unspent template-3 bond output of that node at ${atHeight}`, bound };
  return { verdict: true, why: `a spent-set copy signed at session ${proof.copy.session}, above the halt's bound ${bound} (halt at session ${halt.session})`, output, bound };
}
