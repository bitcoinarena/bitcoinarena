// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCHNORR CHECK, KEPT (ORDER-2116, measured on the free series pair 2026-10-01): a finality watch asks where each run
// stands several times a tick - and every ask verified every result and every FINAL signature of the run again, the
// same bytes against the same key. A CPU profile of a node watching 43 rounds past their window: 50 % of its loop in
// schnorr.verify under resultFinality. A signature's verdict on fixed (signature, digest, key) bytes never changes, so
// it is kept - both answers - in a bounded map, oldest dropped first.
import { schnorr } from '@noble/curves/secp256k1.js';

const KEPT_MAX = 65536;
const kept = new Map();
const hex = (b) => Buffer.from(b).toString('hex');

export function verifyKept(signature, digest, key) {
  const k = `${hex(signature)}:${hex(digest)}:${hex(key)}`;
  const had = kept.get(k);
  if (had !== undefined) return had;
  let ok = false;
  try { ok = !!schnorr.verify(signature, digest, key); } catch { ok = false; }
  kept.set(k, ok);
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value);
  return ok;
}
