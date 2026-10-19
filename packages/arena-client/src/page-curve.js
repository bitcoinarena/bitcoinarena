// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CURVE THE PAGE BRINGS TO A SIGNER NODE.
//
// `@blwp/client` carries no crypto: signing, verifying and this key are
// injected. The daemons already sit on `@noble/curves` secp256k1. This is
// that same curve, loaded beside the client, so a tab can name a real
// BIP-340 key. Without it the page fetches the round and then refuses the
// signer node, and two tabs of the daily are two single-player games.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const hex = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
};
const big = (b) => BigInt('0x' + hex(b));

/** The x-only public key of a secret, which is what a signer node is named by. */
export const pointX = (secret) => schnorr.getPublicKey(secret);

export const pointFromScalar = (scalar) => {
  const k = typeof scalar === 'bigint' ? scalar : big(scalar);
  if (k % secp256k1.Point.Fn.ORDER === 0n) return new Uint8Array(33);
  return secp256k1.Point.BASE.multiply(k % secp256k1.Point.Fn.ORDER).toBytes(true);
};

export const combinePoints = (terms) => {
  let sum = null;
  for (const { point, coefficient } of terms) {
    const k = (typeof coefficient === 'bigint' ? coefficient : big(coefficient))
      % secp256k1.Point.Fn.ORDER;
    if (k === 0n) continue;
    if (point.length === 33 && point.every((b) => b === 0)) continue;
    const p = secp256k1.Point.fromBytes(point).multiply(k);
    sum = sum === null ? p : sum.add(p);
  }
  return sum === null ? new Uint8Array(33) : sum.toBytes(true);
};

/** ECDSA over a 32-byte digest by a 33-byte key: a developer's ballot signature (§27A.4.1). */
export const verifyEcdsa = (sig, digest, key) => { try { return secp256k1.verify(sig, digest, key); } catch { return false; } };

/** BIP-340. Node adverts and receipts are schnorr under the bond key. */
export const verify = (sig, msg, key) => {
  try { return schnorr.verify(sig, msg, key); }
  catch { return false; }
};

export const ecdhShared = (secret, theirXOnly) => {
  const n = secp256k1.Point.Fn.ORDER;
  const d = (typeof secret === 'bigint' ? secret : big(secret)) % n;
  if (d === 0n) throw new Error('zero is not a secret key');
  const x = schnorr.utils.lift_x(big(theirXOnly)).multiply(d).toAffine().x
    .toString(16).padStart(64, '0');
  return Uint8Array.from(x.match(/../g).map((h) => parseInt(h, 16)));
};

/**
 * A BIP-340 SIGNATURE, which a Nostr event is (NIP-01).
 *
 * The page had no reason to SIGN on this curve until the wallet: its own
 * session key is Ed25519 through `crypto.subtle`, and the player key was only
 * ever a public point. NIP-47 puts a request on a relay as a signed event, so
 * this is the one operation the connection secret performs - and it signs an
 * event id, never a Bitcoin message: the two live on the same curve and mean
 * entirely different things.
 */
export const signSchnorr = (message, secret) => schnorr.sign(message, secret);

/**
 * THE TWO OPERATIONS A BOND'S OUTPUT KEY IS REBUILT WITH (the client checks each census bond itself), as a
 * seat's curve.js does them on x-only keys: Q = lift_x(P) + t*G with its parity, and the sum of lift_x(key)*coefficient.
 */
export const bondTweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
export const bondCombine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? p : sum.add(p);
  }
  return schnorr.utils.pointToBytes(sum);
};

export const pageCurve = {
  pointX, ecdhShared, pointFromScalar, combinePoints, verify, signSchnorr, bondTweakPoint, bondCombine,
};
