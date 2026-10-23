// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE COMMITTEE THRESHOLD, the one rule the door, the settle, the verdict and
 * the page all read: 2 slots -> 2-of-2 (this build), 7 slots -> 5-of-7.
 *
 * Its own module so the client bundle can carry it without genesis.js, which
 * reaches into the engine. `genesis.js` re-exports it for the node.
 */
export function receiptsNeeded(slots) {
  if (slots === 2) return 2;
  if (slots === 7) return 5;
  // A CONTRACT THAT NAMES ITS DRAW (§5A.7 reserve seats): 9 drawn for 7 seats, 3 for 2 - the threshold is the
  // seats', never more of the drawn than the seats need
  if (slots === 9) return 5;
  if (slots === 3) return 2;
  throw new Error(`no committee threshold for ${slots} slots`);
}

/**
 * A FEDERATION'S OWN THRESHOLD over its guardian seats (§23A: "2f + 1 ... 7 of 10, 5 of 7, 3 of 4"; fedimint's own n - floor((n - 1) / 3)):
 * what its reserve key needs (§27A.9.2, "the 5-of-7 key of its guardian seats"). Not a game committee's threshold (receiptsNeeded) -
 * that one knows the committee sizes only, and a federation of the founding's ten got no reserve key from it (kanban #397, 2026-10-23).
 */
export function guardianThreshold(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`no guardian threshold for ${n} seats`);
  return n - Math.floor((n - 1) / 3);
}
