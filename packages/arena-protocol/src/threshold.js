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
  // A CONTRACT THAT NAMES ITS DRAW (§5A.7 reserve seats, kanban #301): 9 drawn for 7 seats, 3 for 2 - the threshold is the
  // seats', never more of the drawn than the seats need
  if (slots === 9) return 5;
  if (slots === 3) return 2;
  throw new Error(`no committee threshold for ${slots} slots`);
}
