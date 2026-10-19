// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S FINAL SIGNATURE (§13A, WINDOW-10-SPEC, RULED 2026-10-01).
//
// "A result is FINAL only when five settlement seats have each signed FINAL for it, and a seat signs only once its own
// clock reads final_after and it holds no valid objection." "Signed times are checked on arrival. A seat counts a result
// or FINAL signature only if the time it carries is within the tolerance of the receiving seat's own clock. A
// back-dated or forward-dated signature does not count and is itself evidence against its signer."
//
// The record: the round, the entry, the run it makes FINAL (the agreed run id - the first result's, or an agreed
// re-run's), the seat that signs, and the time it signed on its own clock. The count: distinct committee seats whose
// signature verifies, signed at or after the window's final_after, and received within the tolerance of the
// receiving seat's clock (the `seenMs` it was stored with) - at the round's own threshold (5 of 7, 2 of 2).
//
// The curve is not this package's business: `verify(signature, digest, key)` is injected, as rerun.js takes it.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_FINAL_SIGNATURE, TAG } from './constants.js';
import { receiptsNeeded } from './threshold.js';
import { withinTolerance } from './window.js';

/** 1 type + 2 version + 32 round + 32 entry + 32 run + 32 signer + 8 signed at. */
export const FINAL_SIG_BYTES = 1 + 2 + 32 + 32 + 32 + 32 + 8;
export const FINAL_SIG_SIGNATURE_BYTES = 64;
export const SIGNED_FINAL_SIG_BYTES = FINAL_SIG_BYTES + FINAL_SIG_SIGNATURE_BYTES;

const fsIs32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeFinalSig({ roundId, entryId, runId, signerPubkey, signedAtMs }) {
  const w = new Writer();
  w.u8(TYPE_FINAL_SIGNATURE);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.bytes32(entryId);
  w.bytes32(runId);
  w.bytes32(signerPubkey);
  w.u64(BigInt(signedAtMs));
  return w.finish();
}

export function decodeFinalSig(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FINAL_SIGNATURE) throw new Error('not a FINAL signature');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('protocol version ' + version);
  const x = { roundId: r.bytes32(), entryId: r.bytes32(), runId: r.bytes32(), signerPubkey: r.bytes32(), signedAtMs: r.u64() };
  r.end();
  return x;
}

/** What the seat signs. */
export const finalSigId = (x) => taggedHash(TAG.finalSignature, encodeFinalSig(x));

export function joinSignedFinalSig(body, signature) {
  if (body.length !== FINAL_SIG_BYTES) throw new Error(`a FINAL signature body is ${FINAL_SIG_BYTES} bytes, got ${body.length}`);
  if (signature.length !== FINAL_SIG_SIGNATURE_BYTES) throw new Error(`a signature is ${FINAL_SIG_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(SIGNED_FINAL_SIG_BYTES);
  out.set(body, 0);
  out.set(signature, FINAL_SIG_BYTES);
  return out;
}

export function splitSignedFinalSig(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_FINAL_SIG_BYTES)
    throw new Error(`a signed FINAL signature is ${SIGNED_FINAL_SIG_BYTES} bytes`);
  return { body: bytes.subarray(0, FINAL_SIG_BYTES), signature: bytes.subarray(FINAL_SIG_BYTES) };
}

/** Sign one FINAL record with `sign(digest) -> 64-byte signature`. */
export function signFinalSig(x, sign) {
  const body = encodeFinalSig(x);
  return joinSignedFinalSig(body, sign(finalSigId(x)));
}

/**
 * WHY ONE ARRIVING FINAL SIGNATURE DOES NOT COUNT, or null if it does: about this round, entry and run; a committee
 * seat; a signature that verifies; signed at or after `finalAfterMs`; and signed within the tolerance of `seenMs`, the
 * receiving seat's own clock when it arrived.
 */
export function finalSigFault({ bytes, seenMs }, { roundId, entryId, runId, committee, finalAfterMs, verify }) {
  let x, signature;
  try {
    const split = splitSignedFinalSig(bytes);
    signature = split.signature;
    x = decodeFinalSig(split.body);
  } catch (e) { return { why: `not a FINAL signature: ${e.message}` }; }
  if (toHex(x.roundId) !== toHex(roundId) || toHex(x.entryId) !== toHex(entryId)) return { x, why: 'about another round or entry' };
  if (runId && toHex(x.runId) !== toHex(runId)) return { x, why: 'about another run' };
  if (!committee.map(toHex).includes(toHex(x.signerPubkey))) return { x, why: 'not signed by a seat of this round\'s committee' };
  let good = false;
  try { good = !!verify(signature, finalSigId(x), x.signerPubkey); } catch { good = false; }
  if (!good) return { x, why: 'the signature does not verify' };
  if (x.signedAtMs < BigInt(finalAfterMs))
    return { x, evidence: true, why: `signed at ${x.signedAtMs}, before the window's final_after ${finalAfterMs}: a seat signed FINAL early` };
  if (seenMs === null || seenMs === undefined || !withinTolerance(x.signedAtMs, seenMs))
    return { x, evidence: true, why: `signed at ${x.signedAtMs} and received at ${seenMs}: outside the 5 s tolerance of the receiving seat's clock` };
  return null;
}

/**
 * IS THIS RUN FINAL? The distinct committee seats whose FINAL signature on `runId` counts (finalSigFault), against the
 * round's threshold for `slots` seats. `records` are `{ bytes, seenMs }`.
 */
export function finalSigned({ roundId, entryId, runId, records, committee, slots, finalAfterMs, verify } = {}) {
  if (!fsIs32(roundId) || !fsIs32(entryId) || !fsIs32(runId)) return { ok: false, signed: 0, why: 'FINAL is counted for one round, one entry and one run' };
  if (typeof verify !== 'function') return { ok: false, signed: 0, why: 'counting FINAL signatures needs a verifier, and none was injected' };
  if (!Array.isArray(committee) || !committee.length) return { ok: false, signed: 0, why: 'this round has no committee to sign FINAL' };
  let needed;
  try { needed = receiptsNeeded(slots); } catch (e) { return { ok: false, signed: 0, why: e.message }; }
  const counted = new Set();
  const refused = [];
  for (const rec of records || []) {
    const fault = finalSigFault(rec, { roundId, entryId, runId, committee, finalAfterMs, verify });
    if (fault) { refused.push({ signer: fault.x ? toHex(fault.x.signerPubkey) : null, why: fault.why, evidence: !!fault.evidence }); continue; }
    counted.add(toHex(decodeFinalSig(splitSignedFinalSig(rec.bytes).body).signerPubkey));
  }
  const signed = counted.size;
  if (signed < needed) return { ok: false, signed, needed, refused, why: `${signed} of ${needed} seats have signed FINAL` };
  return { ok: true, signed, needed, refused, signers: [...counted] };
}
