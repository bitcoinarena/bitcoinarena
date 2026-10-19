// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEV'S READ RECEIPT FOR ITS DONATIONS (2026-10-05 08:15-08:17): once the dev client has written its own
// permanent record of a donation - sender key, round id, amount, time, rates - it tells each seat, signed with its recipient
// key, which outpoints it has read, and the seat deletes those rows entirely. This is the message both sides sign and check.
// The signature (ECDSA, secp256k1, SHA-256, DER) is node's own on both sides: the donor and the seat each run on node.
export const DONATIONS_READ_TAG = 'ARENA/v1/donations-read';
/** How far a receipt's own time may be from the seat's clock: a receipt is sent once and answered at once. */
export const DONATIONS_READ_WINDOW_MS = 10 * 60 * 1000;
/** The 33-byte compressed key as SPKI DER, for node's createPublicKey. */
export const SECP256K1_SPKI_PREFIX = '3036301006072a8648ce3d020106052b8104000a032200';

export function donationsReadMessage({ key, atMs, outpoints }) {
  return new TextEncoder().encode(`${DONATIONS_READ_TAG}\n${String(key).toLowerCase()}\n${Number(atMs)}\n${[...outpoints].map(String).sort().join(',')}`);
}
