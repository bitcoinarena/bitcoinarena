// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE ANSWER TO "IS THIS A KEY?" (kanban #1489, #1675). A key that is paid an output of a round's settlement transaction - a
// website's frontendPk, a donation recipient, a claim key, a purchase's payee or reserve key - must be a secp256k1 point: the
// settlement tool parses every payout key as a point, so one 0x02/0x03 || 32 bytes that is no point makes the round's ONE
// settlement transaction unbuildable for every entry in it. A prefix check alone let 0x02 || 0xff*32 through; every such
// check now asks this module.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const bigOf = (x) => { let v = 0n; for (const b of x) v = (v << 8n) | BigInt(b); return v; };

/** Is `x` (32 bytes) the x coordinate of a secp256k1 point (BIP340 lift_x)? */
export function onCurveX(x) {
  if (!(x instanceof Uint8Array) || x.length !== 32) return false;
  const v = bigOf(x);
  if (v >= P) return false;
  const c = (modpow(v, 3n, P) + 7n) % P;
  const y = modpow(c, (P + 1n) / 4n, P);
  return (y * y) % P === c;
}

/** Is `k` a 33-byte compressed secp256k1 point: 0x02 or 0x03, then an x on the curve? */
export const isCompressedPoint = (k) => k instanceof Uint8Array && k.length === 33 && (k[0] === 0x02 || k[0] === 0x03) && onCurveX(k.subarray(1));
