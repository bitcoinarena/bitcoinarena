// WHAT THE PAGE DOES WITH A PICTURE OF SOMEBODY ELSE'S TRUCK.
//
// Letter 18 got a ghost produced, delivered and decoded: the daemon replays
// what the other player published, pushes it on the /play socket, and
// `Client.takeGhost` hands it to `onGhost` without stealing an RPC answer.
// Measured at the start of 28: `onGhost` had NO consumer anywhere outside the
// tests, `blwp.jslib` had no ghost entry point, and `GhostTruck.Show` had no
// caller. Produced, delivered, decoded - and drawn by nobody.
//
// This is the page's half, and it lives here rather than in `blwp.jslib`
// because that file is the one place `node --test` cannot load: the rule that
// decides whether a player ever sees a competitor should not be the one rule
// with no test. The jslib asks for the frames; this decides what is kept.
//
// NOTHING HERE IS AN INPUT. 0.10: another player's truck is a picture, never
// an input to my simulation. A queue of pictures is handed to a renderer and
// to nothing else - `packages/core` is not imported, and cannot be.
import { toHex } from '../../protocol/src/hash.js';

/** How many pictures a page will hold before it starts dropping the oldest. */
export const GHOST_BACKLOG = 240;

/**
 * Subscribe for the round this player is in, and keep what arrives.
 *
 * `where` is the client's own `{ roundId, entryId }` - the same object
 * `setRound` was given - and the entry id in it is the one thing that must
 * never be drawn: a player does not need a picture of the truck they are
 * driving. The daemon already refuses to send one (26/18), and this refuses to
 * keep one, because "the other end will not do that" is not a reason to accept
 * it if it does.
 */
export function watchGhosts(client, where, { limit = GHOST_BACKLOG } = {}) {
  if (!client) throw new Error('no client to watch with');
  if (!where || !where.roundId || !where.entryId)
    throw new Error('a watch names the round and the entry it is watching from');

  const mine = toHex(where.entryId);
  const queue = [];
  // WHO IS HERE, independent of the drain the renderer takes. A picture
  // Unity has already drawn is gone from the queue; it is still a player
  // in the round, and the page's count has to say so.
  const present = new Map();
  const field = {
    seen: 0,
    self: 0,
    shed: 0,
    present,
    get size() { return queue.length; },
    get others() { return present.size; },

    /**
     * The oldest pictures first, up to `max`. A renderer drains what it can
     * draw this frame and leaves the rest; nothing here waits on it.
     */
    drain(max = queue.length) {
      return queue.splice(0, Math.max(0, max | 0));
    },

    /** The newest picture of each truck, which is what a renderer wants. */
    latest() {
      const byEntry = new Map();
      for (const g of queue) byEntry.set(toHex(g.entryId), g);
      return [...byEntry.values()];
    },
  };

  client.onGhost = (ghost) => {
    field.seen++;
    // NEVER YOURSELF.
    if (toHex(ghost.entryId) === mine) { field.self++; return; }

    present.set(toHex(ghost.entryId), ghost);
    queue.push(ghost);
    // A FULL QUEUE SHEDS PICTURES OLDEST FIRST, which is piece 2 of letter 18
    // stated for the page: a picture of where a truck WAS is worth less than
    // the one behind it, and a backlog of them is worse than none.
    while (queue.length > limit) { queue.shift(); field.shed++; }
  };

  field.watching = client.watch(where.roundId, where.entryId);
  return field;
}

/** One line the page can put on screen. Count is 1 (this tab) plus others. */
export function playersLine({ seated, others } = {}) {
  if (!seated) return 'round named · not seated';
  const n = 1 + (others | 0);
  if (n <= 1) return '1 player · waiting';
  return n + ' players in this round';
}
