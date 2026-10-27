// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE AUDITORS' LOTTERY (spec §13A.1, kanban #725): an elliptic-curve VRF, RFC 9381's ECVRF with try-and-increment
// (section 5.4.1.1), nonces from RFC 6979 (5.4.2.1), SHA-256, compressed points, cLen 16. One output per key and input,
// so a node cannot draw again for a better ticket (a Schnorr signature would let it: its nonce is its own choice), and
// nobody but the key's holder can compute it before the proof is shown.
//
// The curve is injected, as everywhere in this package: `Point` is @noble/curves' point class of a prime-order short
// Weierstrass curve (BASE, Fn.ORDER, fromBytes, toBytes, multiply, add, negate, equals). `suite` is the suite byte:
//   0x01  ECVRF-P256-SHA256-TAI       (RFC 9381; its vectors B.1 check this code, vrf.test.js)
//   0xfe  ECVRF-SECP256K1-SHA256-TAI  (the same construction on secp256k1, the suite byte other implementations use)

import { sha256bytes } from './sha256.js';

export const SUITE_P256_TAI = 0x01;
export const SUITE_SECP256K1_TAI = 0xfe;
const C_LEN = 16, Q_LEN = 32, PT_LEN = 33;

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const toInt = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const toBytes = (n, len) => { const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };

function hmac(key, msg) {
  const k = key.length > 64 ? sha256bytes(key) : key;
  const pad = (v) => { const p = new Uint8Array(64).fill(v); for (let i = 0; i < k.length; i++) p[i] ^= k[i]; return p; };
  return sha256bytes(cat(pad(0x5c), sha256bytes(cat(pad(0x36), msg))));
}

/** RFC 6979 section 3.2 for a 256-bit q and SHA-256, the "suitable for DSA" check of h.3 left out (RFC 9381 5.4.2.1). */
function nonce6979(x, m, q) {
  const qlen = q.toString(2).length;
  const bits2int = (b) => { const v = toInt(b); return b.length * 8 > qlen ? v >> BigInt(b.length * 8 - qlen) : v; };
  const h1 = sha256bytes(m);
  let z = bits2int(h1); if (z >= q) z -= q;
  const xb = toBytes(x, Q_LEN), hb = toBytes(z, Q_LEN);
  let V = new Uint8Array(32).fill(1), K = new Uint8Array(32);
  K = hmac(K, cat(V, [0x00], xb, hb)); V = hmac(K, V);
  K = hmac(K, cat(V, [0x01], xb, hb)); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bits2int(V);
    if (k >= 1n && k < q) return k;
    K = hmac(K, cat(V, [0x00])); V = hmac(K, V);
  }
}

/** The VRF of one curve and suite: { prove(secret, alpha) -> pi, verify(publicKey, alpha, pi) -> beta | null, proofToHash(pi) -> beta }. */
export function makeVrf({ Point, suite }) {
  if (!Point || !Point.BASE || !Point.Fn || typeof Point.fromBytes !== 'function') throw new Error('a VRF needs an injected curve point class');
  const q = Point.Fn.ORDER, B = Point.BASE, S = Uint8Array.of(suite);
  const ptStr = (P) => P.toBytes(true);
  const mul = (P, n) => (n % q === 0n ? Point.ZERO : P.multiply(n % q));   // noble refuses a zero scalar
  const strPt = (b) => { try { const P = Point.fromBytes(b); return P.equals(Point.ZERO) ? null : P; } catch { return null; } };
  const encodeToCurve = (pk, alpha) => {
    for (let ctr = 0; ctr < 256; ctr++) {
      const H = strPt(cat(Uint8Array.of(0x02), sha256bytes(cat(S, [0x01], pk, alpha, [ctr], [0x00]))));
      if (H) return H;
    }
    throw new Error('no curve point for that input');
  };
  const challenge = (...pts) => toInt(sha256bytes(cat(S, [0x02], ...pts.map(ptStr), [0x00])).subarray(0, C_LEN));
  const decode = (pi) => {
    if (!(pi instanceof Uint8Array) || pi.length !== PT_LEN + C_LEN + Q_LEN) return null;
    const Gamma = strPt(pi.subarray(0, PT_LEN)); if (!Gamma) return null;
    const c = toInt(pi.subarray(PT_LEN, PT_LEN + C_LEN)), s = toInt(pi.subarray(PT_LEN + C_LEN));
    return s >= q ? null : { Gamma, c, s };
  };
  const proofToHash = (pi) => { const d = decode(pi); if (!d) throw new Error('not a VRF proof'); return sha256bytes(cat(S, [0x03], ptStr(d.Gamma), [0x00])); };

  function prove(secret, alpha) {
    const x = typeof secret === 'bigint' ? secret : toInt(secret);
    if (x <= 0n || x >= q) throw new Error('a VRF secret is a scalar between 1 and q - 1');
    const Y = B.multiply(x), pk = ptStr(Y);
    const H = encodeToCurve(pk, alpha), Gamma = H.multiply(x);
    const k = nonce6979(x, ptStr(H), q);
    const c = challenge(Y, H, Gamma, B.multiply(k), H.multiply(k));
    const s = (k + c * x) % q;
    return cat(ptStr(Gamma), toBytes(c, C_LEN), toBytes(s, Q_LEN));
  }

  /** beta when `pi` proves `alpha` under `publicKey` (33 bytes, compressed), else null. */
  function verify(publicKey, alpha, pi) {
    try { return verifyOrThrow(publicKey, alpha, pi); } catch { return null; }   // a forged proof may land on the identity
  }
  function verifyOrThrow(publicKey, alpha, pi) {
    const Y = strPt(publicKey); if (!Y) return null;
    const d = decode(pi); if (!d) return null;
    const H = encodeToCurve(ptStr(Y), alpha);
    const U = mul(B, d.s).add(mul(Y, d.c).negate());
    const V = mul(H, d.s).add(mul(d.Gamma, d.c).negate());
    return challenge(Y, H, d.Gamma, U, V) === d.c ? proofToHash(pi) : null;
  }
  return { prove, verify, proofToHash, encodeToCurve };
}
