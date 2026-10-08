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
  throw new Error(`no committee threshold for ${slots} slots`);
}
