// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN THE HALT PROOF NAMES ABANDONED, SLASHED (spec §23A.5 "How a halt is proven, and what it slashes" step 3; RULED 2026-11-28 on kanban #3901 Q2).
// A federation that lost 2f + 1 signs no record, so no ABANDONED row ever names its absent guardians (abandoned-slash.js reads only rows) and their bonds
// walked free while the liquidation had nothing to pay with. The ruling: a new proof kind, its own type byte, carrying the halt proof instead of a row.
//
//   PROOF  TYPE_HALT_ABANDONED_PROOF, version, federation_id, the accused's node key, bond txid (internal order) + vout, the newest verified record of the
//          federation (signed bytes), the seats' halt observations (encodeHaltObservation || signature 64) and the guardians' own halt observations
//          (encodeGuardianHaltObservation || signature 64). Its id is TAG.slashProof over the bytes, as every slash proof's.
//   STANDS the record stands on the checker's census (the caller's), the observations make a halt proof on the checker's census seats (halt-proof.js:
//          a majority of active seats, never fewer than five, one S, each spanning abandon_blocks), no session after S is known to the checker
//          (`laterSession`), the accused is a guardian of that record whom the proof names ABANDONED (a guardian that answered through the halt never is),
//          the halt height is at or above the network's ABANDONED_SLASH_HEIGHT, and the output is the accused's template-3 bond output left from before the
//          halt height. The output goes into the liquidation escrow like an abandoned slash's. The old AbandonedProof (TYPE_ABANDONED_PROOF) is unchanged.
//   VOID   a recovery before the slash is spent (2f + 1 back, a session after S) voids it: `laterSession` above S refuses it here.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_HALT_ABANDONED_PROOF, PROTOCOL_VERSION, speaksVersion } from './constants.js';
import { encodeHaltObservation, decodeHaltObservation, encodeGuardianHaltObservation, decodeGuardianHaltObservation, haltProof } from './halt-proof.js';
import { outputsLeft, startsByCensusKey } from './abandoned-slash.js';

const SIG = 64;
const varBytes = (w, b) => { w.u32(b.length); w.bytes(b); };
const readVarBytes = (r) => r.bytes(r.u32());
const signed = (body, signature) => { if (!(signature instanceof Uint8Array) || signature.length !== SIG) throw new Error('a signature is 64 bytes'); return Uint8Array.from([...body, ...signature]); };
const split = (bytes) => ({ body: bytes.subarray(0, bytes.length - SIG), signature: bytes.subarray(bytes.length - SIG) });
const same = (a, b) => toHex(a) === toHex(b);

/** `record` the signed record's bytes; `observations` signed halt observations; `guardianObservations` the guardians' signed ones. */
export function encodeHaltAbandonedProof({ federationId, nodePubkey, txid, vout, record, observations, guardianObservations = [] }) {
  if (!(record instanceof Uint8Array) || !record.length) throw new Error('a halt\'s abandonment proof carries the newest verified record of the federation');
  if (!Array.isArray(observations) || !observations.length) throw new Error('a halt\'s abandonment proof carries the halt observations its halt proof is made of');
  const w = new Writer();
  w.u8(TYPE_HALT_ABANDONED_PROOF); w.u16(PROTOCOL_VERSION);
  w.bytes32(federationId); w.bytes32(nodePubkey); w.bytes32(txid); w.u32(vout);
  varBytes(w, record);
  w.u32(observations.length);
  for (const o of observations) varBytes(w, signed(encodeHaltObservation(o), o.signature));
  w.u32(guardianObservations.length);
  for (const o of guardianObservations) varBytes(w, signed(encodeGuardianHaltObservation(o), o.signature));
  return w.finish();
}
export function decodeHaltAbandonedProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_HALT_ABANDONED_PROOF) throw new Error('not a proof of a guardian a halt left abandoned');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { federationId: r.bytes32(), nodePubkey: r.bytes32(), txid: r.bytes32(), vout: r.u32(), record: readVarBytes(r) };
  const n = r.u32(); p.observations = [];
  for (let i = 0; i < n; i++) { const o = split(readVarBytes(r)); p.observations.push({ ...decodeHaltObservation(o.body), signature: o.signature }); }
  const g = r.u32(); p.guardianObservations = [];
  for (let i = 0; i < g; i++) { const o = split(readVarBytes(r)); p.guardianObservations.push({ ...decodeGuardianHaltObservation(o.body), signature: o.signature }); }
  r.end();
  if (!p.record.length || !n) throw new Error('a halt\'s abandonment proof carries its record and its halt observations');
  return p;
}
export const isHaltAbandonedProof = (bytes) => bytes instanceof Uint8Array && bytes[0] === TYPE_HALT_ABANDONED_PROOF;
export const haltAbandonedProofId = (bytes) => taggedHash(TAG.slashProof, bytes);

/**
 * MAY THIS OUTPUT BE SLASHED ON THIS HALT, on one checker's own reads. `record` the proof's record, decoded and already held to its threshold on the checker's
 * census; `proof` decoded; `censusSeats` the node keys of the checker's census's active seats; `abandonBlocks`; `laterSession` the highest session the checker
 * knows of from a verified record or a signed attestation (null: none) - one after S voids the halt; `bonds` the checker's census read; `from` the network's
 * ABANDONED_SLASH_HEIGHT. Answers { verdict, why, output?, halt? }.
 */
export function haltAbandonedSlashStands({ record, proof, verify, censusSeats, abandonBlocks, laterSession = null, bonds, from }) {
  if (!same(record.federationId, proof.federationId)) return { verdict: false, why: 'that record is another federation\'s' };
  const seat = (record.guardians || []).find((g) => same(g.nodePubkey, proof.nodePubkey));
  if (!seat) return { verdict: false, why: 'that record does not seat that node as a guardian' };
  const halt = haltProof(proof.observations, { record, censusSeats, abandonBlocks, verify, laterSession, guardianObservations: proof.guardianObservations });
  if (!halt.ok) return { verdict: false, why: `no halt proven: ${halt.why}` };
  if (!halt.abandoned.some((k) => same(k, seat.peerKey))) return { verdict: false, why: 'the halt proof does not name that guardian ABANDONED: it answered through the halt, or departed before it', halt };
  if (!Number.isInteger(from) || halt.haltHeight < from) return { verdict: false, why: `a halt at ${halt.haltHeight} is below this network's abandoned-slash height ${from}`, halt };
  const output = outputsLeft(bonds, proof.nodePubkey, halt.haltHeight).find((o) => o.txid === toHex(proof.txid) && o.vout === proof.vout);
  if (!output) return { verdict: false, why: `${toHex(proof.txid).slice(0, 16)}:${proof.vout} is no output of that node left from before the halt at ${halt.haltHeight}`, halt };
  if (!startsByCensusKey(output.template)) return { verdict: false, why: 'that output is no template-3 bond: the census key starts template 3 only', halt };
  return { verdict: true, why: `ABANDONED by the halt proof of session ${halt.session} (halt at ${halt.haltHeight}, ${halt.observers} observers)`, output, halt };
}

/**
 * WHEN A SEAT FILES A HALT'S ABANDONMENT (kanban #3901, measured on the devnet 2026-11-28): the seats' halt proof stood at 14 observers before either live guardian of
 * the halted federation had signed its own halt observation (a guardian signs from abandon_blocks after it first saw the session, on its own pass), so the proof named
 * all four ABANDONED and the census key started the two live guardians' bonds too - and an idle federation whose session had not moved got its seven honest guardians
 * started the same way. Who is slashed is read from the guardians' signatures (#1289), so a seat files only once they have had abandon_blocks more to give them:
 * at a tip of the halt height + 2 x abandon_blocks or later. Local to the filer: the judgement of a proof is unchanged.
 */
export const haltSlashDue = ({ tip, haltHeight, abandonBlocks }) => Number.isInteger(tip) && Number.isInteger(haltHeight) && Number.isInteger(abandonBlocks)
  && tip >= haltHeight + 2 * abandonBlocks;

