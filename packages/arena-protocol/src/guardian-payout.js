// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN IS PAID TO THE PAYOUT KEY OF ITS CENSUS ADVERTISEMENT (§22A v4.6.4: "paid as one payout contract per guardian in the
// round's settlement transaction to the payout_pubkey of his census advertisement"; gap 2). From SEATED_GUARDIAN_VERSION.
// Measured 2026-10-17 on the 13 census adverts of round 32cfad1c: every one names 32 bytes of 0x03 - a placeholder, not a key a
// guardian holds. Such a key, or any x that is not on the curve, is no payout key: that guardian is paid at its node key, as before,
// so no share is ever sent to a key nobody can spend.

// The curve check lives in point.js (kanban #1675: one check for every payout key); re-exported for the callers of this module.
import { onCurveX } from './point.js';
export { onCurveX };

/** The placeholder every advert carried until real keys: 32 bytes of 0x03. */
export const isPlaceholderKey = (x) => x instanceof Uint8Array && x.length === 32 && x.every((b) => b === 0x03);

/** The 33-byte payout key of an advert's x-only payout_pubkey (BIP340: the even point), or null when it is none. */
export function guardianPayoutKeyOf(payoutPubkey) {
  if (!(payoutPubkey instanceof Uint8Array) || payoutPubkey.length !== 32 || isPlaceholderKey(payoutPubkey) || !onCurveX(payoutPubkey)) return null;
  return Uint8Array.from([0x02, ...payoutPubkey]);
}
