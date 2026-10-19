// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Tagged hashing, BIP-340 style.
//
//   H_tag(x) = sha256( sha256(tag) || sha256(tag) || x )
//
// The doubled tag digest is what makes the prefix impossible to collide into
// by choosing a message: an attacker would have to find a message beginning
// with 64 bytes they do not control.
//
// sha256 comes from @blwp/core rather than a library. It is integer-only and
// already carried through the determinism harness, and a hash that pins money
// should not gain a dependency whose version could change its output.

import { sha256bytes } from './sha256.js';
import { utf8Encode } from './utf8.js';

const tagCache = new Map();

function tagPrefix(tag) {
  let p = tagCache.get(tag);
  if (p === undefined) {
    const d = sha256bytes(utf8Encode(tag));
    p = new Uint8Array(64);
    p.set(d, 0);
    p.set(d, 32);
    tagCache.set(tag, p);
  }
  return p;
}

/** Tagged hash of some bytes. Returns 32 bytes. */
/**
 * PLAIN SHA-256, named here so that nothing outside this package has to reach
 * into the core for it.
 *
 * `arena-node` may touch the simulator through exactly one door - `replay.js` -
 * and an `import` of `core/src/sha256.js` for a stake commitment is that rule
 * being weakened for a good reason, which is how it would always go. The hash
 * is not a simulation; it belongs to the protocol, and it lives here.
 */
export const sha256 = (bytes) => sha256bytes(bytes);

export function taggedHash(tag, bytes) {
  const prefix = tagPrefix(tag);
  const buf = new Uint8Array(prefix.length + bytes.length);
  buf.set(prefix, 0);
  buf.set(bytes, prefix.length);
  return sha256bytes(buf);
}

// ONE FLAT STRING, NOT A ROPE (2026-10-15: "Do everything you can to lower the load"). `s +=` two characters a byte
// built a V8 cons string - a tree of up to 79 string objects for a 32-byte id - and every id kept as a Map key, a Set entry or
// in a list kept the whole tree: a testnet4 seat's heap held 722,473 such trees in lists and 121,912 in maps and sets,
// 1,096 MB of its 1,260 MB (heap snapshot of seat 3, measured). The pieces joined once make one sequential string of the
// same characters, about 80 bytes for an id.
const HEX_PAIRS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const toHex = (bytes) => {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = HEX_PAIRS[bytes[i]];
  return out.join('');
};

export function fromHex(hex) {
  if (hex.length & 1) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i << 1, 2), 16);
  return out;
}

/** Big-endian bytes to BigInt. Used for sortition tickets. */
export function bytesToBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
