// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNATURE CHECKED ONCE IS NOT CHECKED AGAIN (kanban #576, measured 2026-10-23 with 20 market bots: a seat verifies the same
// donation set, seating and batch-certificate signatures over and over - each pass of its timers re-reads what it holds).
// A verification is a pure function of (signature, message, key), so its answer - true or false - is kept under all three,
// in one bounded map per curve: at most KEEP answers, the oldest dropped first. A malformed input throws inside and is false,
// exactly as at the call sites this replaces.
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const KEEP = 16384;
const bytes = (x) => (x instanceof Uint8Array ? x : null);

function kept(verify) {
  const answers = new Map();
  return (sig, msg, key) => {
    const s = bytes(sig), m = bytes(msg), k = bytes(key);
    // anything but three byte strings is checked as it comes and not kept (the verifier decides what it accepts)
    if (!s || !m || !k) { try { return verify(sig, msg, key); } catch { return false; } }
    const q = `${Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('base64')}.${Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString('base64')}.${Buffer.from(k.buffer, k.byteOffset, k.byteLength).toString('base64')}`;
    const had = answers.get(q);
    if (had !== undefined) return had;
    let ok = false;
    try { ok = !!verify(s, m, k); } catch { ok = false; }
    answers.set(q, ok);
    if (answers.size > KEEP) answers.delete(answers.keys().next().value);
    return ok;
  };
}

/** schnorr.verify (BIP-340), kept. */
export const verifySchnorrKept = kept((sig, msg, key) => schnorr.verify(sig, msg, key));
/** ed25519.verify, kept. */
export const verifyEd25519Kept = kept((sig, msg, key) => ed25519.verify(sig, msg, key));
