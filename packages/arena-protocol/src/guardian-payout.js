// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN IS PAID TO THE PAYOUT KEY OF ITS CENSUS ADVERTISEMENT (§22A v4.6.4: "paid as one payout contract per guardian in the
// round's settlement transaction to the payout_pubkey of his census advertisement"; kanban #33 gap 2). From SEATED_GUARDIAN_VERSION.
// Measured 2026-10-17 on the 13 census adverts of round 32cfad1c: every one names 32 bytes of 0x03 - a placeholder, not a key a
// guardian holds. Such a key, or any x that is not on the curve, is no payout key: that guardian is paid at its node key, as before,
// so no share is ever sent to a key nobody can spend.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };

/** Is `x` (32 bytes) the x coordinate of a secp256k1 point (BIP340 lift_x)? */
export function onCurveX(x) {
  if (!(x instanceof Uint8Array) || x.length !== 32) return false;
  const v = BigInt('0x' + Buffer.from(x).toString('hex'));
  if (v >= P) return false;
  const c = (modpow(v, 3n, P) + 7n) % P;
  const y = modpow(c, (P + 1n) / 4n, P);
  return (y * y) % P === c;
}

/** The placeholder every advert carried until real keys: 32 bytes of 0x03. */
export const isPlaceholderKey = (x) => x instanceof Uint8Array && x.length === 32 && x.every((b) => b === 0x03);

/** The 33-byte payout key of an advert's x-only payout_pubkey (BIP340: the even point), or null when it is none. */
export function guardianPayoutKeyOf(payoutPubkey) {
  if (!(payoutPubkey instanceof Uint8Array) || payoutPubkey.length !== 32 || isPlaceholderKey(payoutPubkey) || !onCurveX(payoutPubkey)) return null;
  return Uint8Array.from([0x02, ...payoutPubkey]);
}
