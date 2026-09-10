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
 * THE TICK WORD OF A RETIRE. No picture has a negative tick, so the same twelve
 * words `BlwpNextGhost` already carries say "take this seat's truck away" -
 * `GhostField.Show` reads a tick below zero as exactly that.
 */
export const RETIRE_TICK = -1;

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
  // WHO THIS TAB IS, not only which seat it holds. A reload keeps the player's
  // key and draws a new entry, so this tab's pre-reload seat is still in the
  // round and is still this player (`Client.join` keeps the key it seated).
  const me = where.playerPubkey || client.playerPubkey || null;
  const myKey = me ? toHex(me) : null;
  // ONE TRUCK PER PLAYER, and the picture that arrived LAST is that player's.
  // A reload leaves the player's old seat in the round with a frozen run that
  // may have gone further than the live one - measured 2026-09-10: dead seats
  // at ticks 4229 and 4227, the live other at 3041, and the chip named the
  // dead one at -97,-10 because `newestPose` takes the highest tick. A dead
  // seat never sends again, so the live seat's next picture replaces it. A
  // picture that names no player is keyed by its entry, as before.
  const whoOf = (g) => (g.playerPubkey ? 'p:' + toHex(g.playerPubkey) : 'e:' + toHex(g.entryId));
  // AND ONE SEAT OF EACH PLAYER IS THE ONE UNITY DRAWS. Unity keeps a truck per
  // seat and never removed one, so every seat a player had left stood frozen:
  // measured 2026-09-10 on the Daily, a reload handed Unity 9 and 11 seats, 8
  // and 10 of them abandoned (one picture each), and a watched player's reload
  // left its 105-picture seat frozen beside the new one. A seat is PROVEN once
  // it sends a second picture - an abandoned seat never does.
  const drawnSeat = new Map();   // player -> { e, entryId, playerPubkey }
  const pictures = new Map();    // seat -> pictures seen
  const queue = [];
  const retire = (seat) => {
    queue.push({ entryId: seat.entryId, playerPubkey: seat.playerPubkey, x: 0, z: 0, heading: 0,
      tick: RETIRE_TICK, retire: true });
    field.retired++;
  };
  // WHO IS HERE, independent of the drain the renderer takes. A picture
  // Unity has already drawn is gone from the queue; it is still a player
  // in the round, and the page's count has to say so.
  const present = new Map();
  const field = {
    seen: 0,
    self: 0,
    shed: 0,
    // seats a player left, told to Unity to take away; and first pictures of
    // another seat while this player's drawn seat is live, never drawn
    retired: 0,
    superseded: 0,
    // HOW MANY PICTURES SOMEBODY ACTUALLY TOOK TO DRAW.
    //
    // A field that is filling and never drained looks exactly like a field
    // that is empty from the outside: `others` counts trucks in the round
    // either way. That is the shape of the 11:51 failure - the chip said five
    // players and the screen showed one truck - and the page had no number
    // that could tell the two apart.
    drawn: 0,
    present,
    get size() { return queue.length; },
    get others() { return present.size; },

    /**
     * The oldest pictures first, up to `max`. A renderer drains what it can
     * draw this frame and leaves the rest; nothing here waits on it.
     */
    drain(max = queue.length) {
      const took = queue.splice(0, Math.max(0, max | 0));
      field.drawn += took.length;
      return took;
    },

    /**
     * PICTURES ARE ARRIVING AND NOBODY IS DRAWING THEM.
     *
     * True when the field has been sent pictures of somebody else and none of
     * them has ever been taken. A renderer calls `drain` every frame, so one
     * frame of a working page clears this; a page whose `GhostField` is not in
     * the scene, or whose bridge is not wired, never does - and that is a
     * different fault from an empty round, which is what it used to look like.
     */
    get stalled() { return field.seen > field.self && field.drawn === 0; },

    /**
     * The newest picture of each truck, which is what a renderer wants.
     *
     * OFF `present`, NOT OFF THE QUEUE. It used to read the queue, and the
     * queue is what `drain` empties - so a renderer that drew its frame and
     * then asked what it was holding was told NOTHING, while the trucks were
     * still in the round. Measured: two frames in, `latest()` said one
     * picture; after one `drain(24)` - which is exactly what
     * `GhostField.Draw(PerFrame)` does every frame - it said zero.
     *
     * `present` exists for this and says so three lines up: "A picture Unity
     * has already drawn is gone from the queue; it is still a player in the
     * round." Reading the queue made that comment false for every caller but
     * the first.
     */
    latest() {
      return [...present.values()];
    },
  };

  client.onGhost = (ghost) => {
    field.seen++;
    // NEVER YOURSELF - this seat, or any earlier seat of this same player.
    if (toHex(ghost.entryId) === mine
        || (myKey && ghost.playerPubkey && toHex(ghost.playerPubkey) === myKey)) { field.self++; return; }

    const who = whoOf(ghost);
    const seat = toHex(ghost.entryId);
    const n = (pictures.get(seat) || 0) + 1;
    pictures.set(seat, n);
    const drawn = drawnSeat.get(who);
    if (drawn && drawn.e !== seat) {
      // A FIRST PICTURE OF ANOTHER SEAT WHILE THE DRAWN ONE IS LIVE is a seat
      // that player left: it never reaches Unity.
      if (n < 2 && (pictures.get(drawn.e) || 0) >= 2) { field.superseded++; return; }
      // Otherwise the drawn seat is the one superseded, and Unity is told.
      retire(drawn);
    }
    drawnSeat.set(who, { e: seat, entryId: ghost.entryId, playerPubkey: ghost.playerPubkey });

    present.set(who, ghost);
    queue.push(ghost);
    // A FULL QUEUE SHEDS PICTURES OLDEST FIRST, which is piece 2 of letter 18
    // stated for the page: a picture of where a truck WAS is worth less than
    // the one behind it, and a backlog of them is worse than none. A RETIRE IS
    // NEVER SHED: dropping one would leave that truck standing for good.
    while (queue.length > limit) {
      const i = queue.findIndex((g) => !g.retire);
      if (i < 0) break;
      queue.splice(i, 1);
      field.shed++;
    }
  };

  field.watching = client.watch(where.roundId, where.entryId);
  return field;
}

/** Q16.16: the words a picture carries, per metre. `GhostTruck.ONE` is the same number. */
const ONE_METRE = 65536;

/**
 * WHERE THE NEWEST OTHER TRUCK IS, in metres, or null for nobody.
 *
 * A truck that is drawn 100 m down the frontage and a truck that is not drawn
 * at all look identical through a windscreen, and `stalled` only separates
 * them when NOTHING was ever drawn. Each player parks at their own loading
 * bay - 24 doors at 6.8 m - so two tabs on one round start up to 156 m apart
 * along the same apron, which is exactly far enough to be off screen.
 *
 * So the page says the place. The operator reads it against the position the
 * other tab's own HUD shows: the same two numbers means the picture is right
 * and the camera is pointed elsewhere, different numbers means it is not.
 */
export function newestPose(field) {
  if (!field || typeof field.latest !== 'function') return null;
  let best = null;
  for (const g of field.latest()) if (best === null || g.tick > best.tick) best = g;
  return best === null ? null : { x: best.x / ONE_METRE, z: best.z / ONE_METRE, tick: best.tick };
}

/**
 * One line the page can put on screen. Count is 1 (this tab) plus others.
 *
 * `refused` is THIS TAB'S OWN transcript being turned away by the node, and it
 * comes first because it is the one fault the other numbers cannot show. A tab
 * whose batches stopped landing keeps its socket, keeps its player count and
 * keeps driving; what it loses is every watcher's picture of it, frozen at the
 * last tick that landed. That is what the 16:08 two-Chrome close-out saw from
 * the other side, and neither tab had a number that said so.
 */
export function playersLine({ seated, others, stalled = false, at = null, refused = null,
  seatRefused = null, stake = null } = {}) {
  // WHY THERE IS NO SEAT, AND NOT MERELY THAT THERE IS NONE.
  //
  // Letter 15 made the page refuse a paying round whose settlement committee
  // it cannot learn - and the refusal went to `console.error`, so the chip
  // read "round named · not seated" exactly as it does for a round nobody was
  // sent to. Worse, the bridge then threw "the page did not say which round to
  // play", which names the wrong cause entirely. A refusal nobody can see is
  // the silent seat again, wearing the other hat.
  if (seatRefused) return `not seated · ${seatRefused}`;
  if (!seated) return 'round named · not seated';
  if (refused) return `not publishing · ${refused}`;

  // AND WHETHER THIS SEAT IS PAID FOR.
  //
  // A dealt stake is not a funded one: the page deals the preimage and the
  // shares, and paying the hold invoice is a wallet it has not got yet (M3.2).
  // Without this line a free seat and a funded seat read identically, which is
  // the thing letter 15 exists to stop.
  //
  // THE WORD IS THE NODE'S. `Client.join` keeps the `x-hold` the node answered
  // when it took the entry; a page that printed "not paid" as a constant would
  // be reporting its own assumption as the player's balance.
  const funding = stakeLine(stake);
  const n = 1 + (others | 0);
  // THE FUNDING WORD IS ON EVERY BRANCH, and it was not: this returned early
  // for a lone player, so the one line a player sits looking at while they
  // wait for somebody else - the longest-lived line on the chip - was the one
  // that did not say the seat was unpaid. Its own test caught it.
  if (n <= 1) return '1 player · waiting' + funding;
  // A PAGE THAT IS BEING SENT TRUCKS AND DRAWING NONE SAYS SO. Without this
  // the line reads the same as a page that is drawing them, which is what
  // made the 11:51 retest a guess: five players on the chip, one truck on the
  // screen, and no number between them.
  const where = at ? ` · other at ${Math.round(at.x)},${Math.round(at.z)} m` : '';
  return n + ' players in this round' + (stalled ? ' · none drawn' : '') + where + funding;
}

/**
 * WHAT THE SEAT COST, IN THE WORDS THE NODE USED.
 *
 * `free seat` is a round that asks no stake - there is nothing to pay and
 * nothing was dealt. `stake dealt, unpaid` is a paying round the page has
 * dealt a preimage and shares for and has no hold for, with the node's reason.
 *
 * A HOLD IS COUNTED, NOT NAMED (23.1 step 5). The node's seat-time `x-hold`
 * word used to be printed here, and it said "held" for an invoice nobody had
 * paid - lnd's OPEN and ACCEPTED both read as held. Now a hold reads "not yet
 * counted" until `stakeSeenBy` has asked the settlement seats, and then
 * "stake seen by N of M nodes (T needed)", with the seats that did not answer
 * named and "committed" only at N >= T.
 */
export function stakeLine(stake) {
  if (!stake) return '';
  if (stake.free) return ' · free seat';
  if (!stake.dealt) return '';
  const s = stake.seen;
  // A SEAT THE NODE ISSUED NO HOLD FOR, THAT NOBODY HAS SEEN, KEEPS THE NODE'S
  // REASON. "0 of 2" there would hide why the stake can never be held - the
  // thing letter 15 put on the chip. Once any seat has seen it (a hold issued
  // later and paid), the count is the truth.
  const noHold = stake.hold && stake.hold.state === 'none';
  if (s && typeof s.seen === 'number' && !(noHold && s.seen === 0)) {
    return ` · stake seen by ${s.seen} of ${s.of} nodes (${s.needed} needed)`
      + (s.unanswered ? `, ${s.unanswered} did not answer` : '')
      + (s.committed ? ' · committed' : '');
  }
  const held = stake.hold && stake.hold.state;
  if (held && held !== 'none') return ' · stake dealt, not yet counted';
  const why = stake.hold && stake.hold.why;
  return ' · stake dealt, unpaid' + (why ? ` (${why})` : '');
}
