// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
// to nothing else - `packages/nextblock` is not imported, and cannot be.
import { toHex } from '../../arena-protocol/src/hash.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';

/** How many pictures a page will hold before it starts dropping the oldest. */
export const GHOST_BACKLOG = 240;
/**
 * HOW LONG A TRUCK MAY BE QUIET BEFORE ITS PICTURE IS CALLED STALE (a live run sends ten a second).
 *
 * It used to RETIRE the truck at this age, and that is what the owner photographed on 2026-09-18 10:42: the other truck
 * missing, and then somewhere else. Measured on the Daily the same hour: 5231 pictures, gaps to 5131 ms, nine of them
 * over three seconds - every one of those took a truck off the screen and the next picture put it back, metres away.
 * The pose itself was never drifting (p50 2, p90 3 ticks behind the driver in every third of a round).
 *
 * So silence no longer takes a truck away. It stands where its last picture put it and the label's age grows, which is
 * the truth and is readable; a truck leaves the screen only when the page KNOWS it is gone - the player's next entry
 * supersedes it, or a new round clears the field.
 */
export const SILENT_MS = 3000;

/**
 * THE TICK WORD OF A RETIRE. No picture has a negative tick, so the same twelve
 * words `BlwpNextGhost` already carries say "take this entry's truck away" -
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
export function watchGhosts(client, where, { limit = GHOST_BACKLOG, clock = Date.now } = {}) {
  if (!client) throw new Error('no client to watch with');
  if (!where || !where.roundId || !where.entryId)
    throw new Error('a watch names the round and the entry it is watching from');

  const mine = toHex(where.entryId);
  // WHO THIS TAB IS, not only which entry it holds. A reload keeps the player's
  // key and draws a new entry, so this tab's pre-reload entry is still in the
  // round and is still this player (`Client.join` keeps the key it joined).
  const me = where.playerPubkey || client.playerPubkey || null;
  const myKey = me ? toHex(me) : null;
  // ONE TRUCK PER PLAYER, and the picture that arrived LAST is that player's.
  // A reload leaves the player's old entry in the round with a frozen run that
  // may have gone further than the live one - measured 2026-09-10: dead entries
  // at ticks 4229 and 4227, the live other at 3041, and the chip named the
  // dead one at -97,-10 because `newestPose` takes the highest tick. A dead
  // entry never sends again, so the live entry's next picture replaces it. A
  // picture that names no player is keyed by its entry, as before.
  const whoOf = (g) => (g.playerPubkey ? 'p:' + toHex(g.playerPubkey) : 'e:' + toHex(g.entryId));
  // AND ONE ENTRY OF EACH PLAYER IS THE ONE UNITY DRAWS. Unity keeps a truck per
  // entry and never removed one, so every entry a player had left stood frozen:
  // measured 2026-09-10 on the Daily, a reload handed Unity 9 and 11 entries, 8
  // and 10 of them abandoned (one picture each), and a watched player's reload
  // left its 105-picture entry frozen beside the new one. An entry is PROVEN once
  // it sends a second picture - an abandoned entry never does.
  const drawnEntry = new Map();   // player -> { e, entryId, playerPubkey }
  const pictures = new Map();    // entry -> pictures seen
  const queue = [];
  const retire = (entryKey) => {
    queue.push({ entryId: entryKey.entryId, playerPubkey: entryKey.playerPubkey, x: 0, z: 0, heading: 0,
      tick: RETIRE_TICK, retire: true });
    field.retired++;
  };
  // WHO IS HERE, independent of the drain the renderer takes. A picture
  // Unity has already drawn is gone from the queue; it is still a player
  // in the round, and the page's count has to say so.
  const present = new Map();
  // HOW EACH DRAWN TRUCK LAST MOVED, for the debug label over it (2026-09-17 19:15): the arrows between its last
  // two pictures and when the newest arrived.
  const motion = new Map();
  const field = {
    present,
    motion,
    seen: 0,
    self: 0,
    shed: 0,
    // entries a player left, told to Unity to take away; and first pictures of
    // another entry while this player's drawn entry is live, never drawn
    retired: 0,
    /** Trucks taken away because this page's own run ended: no picture of that round can arrive again. */
    roundEnded: 0,
    /** Set once the run is over and its trucks have been taken away, so it is done once and not every frame. */
    roundDone: false,
    superseded: 0,
    // pictures dropped because a newer one of the same truck was already waiting, and trucks whose newest picture
    // is older than SILENT_MS (counted, not retired)
    collapsed: 0,
    silenced: 0,
    // HOW MANY PICTURES SOMEBODY ACTUALLY TOOK TO DRAW.
    //
    // A field that is filling and never drained looks exactly like a field
    // that is empty from the outside: `others` counts trucks in the round
    // either way. That is the shape of the 11:51 failure - the chip said five
    // players and the screen showed one truck - and the page had no number
    // that could tell the two apart.
    drawn: 0,
    get size() { return queue.length; },
    get others() { return present.size; },

    /**
     * WHAT THE RENDERER DRAWS NOW: every retire, then the NEWEST picture of each truck - never a backlog of where a truck
     * was (2026-09-17 17:05 / 17:12: "the ghost is drawn at a completely different place ... 60 s+ delay ... must
     * be REALTIME"). Pictures queued behind a newer one of the same truck are dropped here, so a tab whose frames paused
     * or fell behind draws each other truck where its newest picture puts it, not where it stood a minute ago. A truck
     * that has sent nothing for SILENT_MS is retired: a live run sends ten pictures a second even parked, so silence is a
     * run that ended or a tab that left, and its truck must not stand frozen. Up to `max` are handed over; the rest stay.
     */
    drain(max = queue.length, nowMs = clock()) {
      // A QUIET TRUCK IS COUNTED, NOT TAKEN AWAY (2026-09-18 10:42). A gap of three or five seconds is the
      // signer nodes stalling, not a player leaving, and removing the truck for it is what "missing, then in the
      // wrong place" was: the next picture drew it again somewhere else.
      field.silenced = 0;
      for (const [, d] of drawnEntry) if (nowMs - d.at > SILENT_MS) field.silenced++;

      // BUT A TRUCK OF A ROUND THAT IS OVER GOES (2026-09-18 12:02: "after 2nd round Truck 1 cannot see
      // Truck 2. Age 6736ms"). Measured on the Daily with a watcher that kept its field across two boundaries: it
      // carried one truck of the round it had left into each new round and never received a single picture of the
      // new one - first picture NEVER, superseded 0, stale pictures 0 - so that truck stood for ever with its age
      // climbing. Until 0.0.1591 the three-second silence took it away; nothing else ever did.
      //
      // This is not the silence rule coming back: a live round keeps its trucks through any stall. What ends them is
      // the page's OWN run being over, because then no picture of that round can ever arrive again.
      if (!field.roundDone && typeof client.runOver === 'function' && (client.ended || client.runOver())) {
        field.roundDone = true;
        for (const [who, d] of drawnEntry) { retire(d); drawnEntry.delete(who); present.delete(who); field.roundEnded++; }
      }
      const retires = [], newest = new Map();
      for (const g of queue) {
        if (g.retire) { retires.push(g); newest.delete(toHex(g.entryId)); } else newest.set(toHex(g.entryId), g);
      }
      const all = retires.concat([...newest.values()]);
      field.collapsed += queue.length - all.length;
      const took = all.slice(0, Math.max(0, max | 0));
      queue.length = 0;
      for (const g of all.slice(took.length)) queue.push(g);
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
    // NEVER YOURSELF - this entry, or any earlier entry of this same player.
    if (toHex(ghost.entryId) === mine
        || (myKey && ghost.playerPubkey && toHex(ghost.playerPubkey) === myKey)) { field.self++; return; }

    const who = whoOf(ghost);
    const entryKey = toHex(ghost.entryId);
    const n = (pictures.get(entryKey) || 0) + 1;
    pictures.set(entryKey, n);
    const drawn = drawnEntry.get(who);
    if (drawn && drawn.e !== entryKey) {
      // A FIRST PICTURE OF ANOTHER ENTRY WHILE THE DRAWN ONE IS LIVE is an entry
      // that player left: it never reaches Unity.
      if (n < 2 && (pictures.get(drawn.e) || 0) >= 2) { field.superseded++; return; }
      // Otherwise the drawn entry is the one superseded, and Unity is told.
      retire(drawn);
    }
    drawnEntry.set(who, { e: entryKey, entryId: ghost.entryId, playerPubkey: ghost.playerPubkey, at: clock() });

    const was = present.get(who);
    const before = motion.get(who);
    motion.set(who, { atMs: clock(),
      glyphs: was && toHex(was.entryId) === entryKey ? moveGlyphs(was, ghost) : (before ? before.glyphs : '') });
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
 * WHICH WAY A TRUCK WENT BETWEEN TWO OF ITS PICTURES, as the debug label draws it (2026-09-17 19:15): an up
 * arrow for forward, a down arrow for back, a left or right arrow for a turn, both when it did both. Read off the
 * pictures - what reached this page through the nodes - not off anybody's keys. Forward is the step along the hull
 * (heading in turns: x = sin, z = cos, a growing heading turns right); a turn is the heading's change, mirrored while
 * backing, so a steer to the right reads right either way. Under 2 cm and under 16 of 65536 of a turn is standing.
 */
export function moveGlyphs(a, b) {
  const dx = (b.x - a.x) / ONE_METRE, dz = (b.z - a.z) / ONE_METRE;
  const h = (b.heading / 65536) * 2 * Math.PI;
  const along = dx * Math.sin(h) + dz * Math.cos(h);
  const back = along < -0.02;
  let dh = ((((b.heading - a.heading) % 65536) + 98304) % 65536) - 32768;
  if (back) dh = -dh;
  return (along > 0.02 ? '\u2191' : back ? '\u2193' : '') + (dh < -16 ? '\u2190' : dh > 16 ? '\u2192' : '');
}

/**
 * THE WALL CLOCK OF EACH TICK A TAB DROVE, shared with the other tabs of this browser (2026-09-17 19:15: "age =
 * how old the last move is, as seen on the other client after it went through the nodes"). A driving tab posts its
 * newest tick and the time it recorded it; a watching tab reads the time of the tick a picture names when that picture
 * is drawn. Only the stamp travels on the channel - the picture itself still comes from the nodes. A tab with no
 * channel, or a truck driven in another browser, has no stamp, and its label says the age since the picture arrived.
 *
 * THE CHANNEL IS HANDED IN, as `sign` and `verify` are: nothing in this package reads a name off the page (the client's
 * own rule, `discovery.test.js`), and a test drives the same door the page does.
 */
export function tickClock({ Channel = null, name = 'arena-ghost-clock', keep = 64 } = {}) {
  const stamps = new Map();
  const put = (e, t, ms) => {
    let a = stamps.get(e);
    if (!a) stamps.set(e, (a = []));
    a.push([t, ms]);
    if (a.length > keep) a.shift();
  };
  let channel = null;
  try { if (typeof Channel === 'function') channel = new Channel(name); } catch { channel = null; }
  if (channel) {
    channel.onmessage = (m) => {
      const d = m && m.data;
      if (d && typeof d.e === 'string' && Number.isInteger(d.t) && Number.isFinite(d.ms)) put(d.e, d.t, d.ms);
    };
  }
  return {
    shared: channel !== null,
    post(entryHex, tick, ms = Date.now()) {
      put(entryHex, tick, ms);
      if (channel) { try { channel.postMessage({ e: entryHex, t: tick, ms }); } catch { /* a closed channel */ } }
    },
    /** When the tab driving `entryHex` recorded `tick`, off its nearest stamp within a second; null when none. */
    sentMs(entryHex, tick) {
      const a = stamps.get(entryHex);
      if (!a) return null;
      let best = null;
      for (const s of a) if (best === null || Math.abs(s[0] - tick) < Math.abs(best[0] - tick)) best = s;
      if (best === null || Math.abs(best[0] - tick) > 60) return null;
      return best[1] + ((tick - best[0]) * 1000) / 60;
    },
    close() { if (channel) channel.close(); },
  };
}

/**
 * ONE DEBUG LABEL PER DRAWN TRUCK: its entry (the key Unity keeps the truck under), the player's name, how old its
 * newest picture is in ms, and how it moved. `estimated` is true when no stamp of the driver's own clock was found and
 * the age is only the time since that picture arrived here.
 */
export function ghostLabels(field, { nowMs = Date.now(), nameOf = () => null, clock = null } = {}) {
  const out = [];
  if (!field || !field.present) return out;
  for (const [who, g] of field.present) {
    const entry = toHex(g.entryId);
    const player = g.playerPubkey ? toHex(g.playerPubkey) : null;
    const name = (player && nameOf(player)) || (g.playerPubkey ? displayNameFromKey(g.playerPubkey) : entry.slice(0, 8));
    const sent = clock ? clock.sentMs(entry, g.tick) : null;
    const m = field.motion ? field.motion.get(who) : null;
    const estimated = sent === null;
    const ageMs = Math.max(0, Math.round(nowMs - (estimated ? (m ? m.atMs : nowMs) : sent)));
    out.push({ entry, name, ageMs, estimated, glyphs: m ? m.glyphs : '' });
  }
  return out;
}

/** The labels as the bridge hands them to Unity: one line a truck, tab-separated, line 2 already written. */
export function ghostLabelText(labels) {
  return labels.map((l) => `${l.entry}\t${l.name}\t${l.estimated ? '~' : ''}${l.ageMs}ms ${l.glyphs}`.trimEnd()).join('\n');
}

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
export function playersLine({ joined, others, stalled = false, at = null, refused = null,
  joinRefused = null, stake = null, names = [] } = {}) {
  // WHY THERE IS NO ENTRY, AND NOT MERELY THAT THERE IS NONE.
  //
  // Letter 15 made the page refuse a paying round whose settlement committee
  // it cannot learn - and the refusal went to `console.error`, so the chip
  // read "round named · not joined" exactly as it does for a round nobody was
  // sent to. Worse, the bridge then threw "the page did not say which round to
  // play", which names the wrong cause entirely. A refusal nobody can see is
  // the silent entry again, wearing the other hat.
  if (joinRefused) return `not joined · ${joinRefused}`;
  if (!joined) return 'round named · not joined';
  if (refused) return `not publishing · ${refused}`;

  // AND WHETHER THIS ENTRY IS PAID FOR.
  //
  // A dealt stake is not a funded one: the page deals the preimage and the
  // shares, and paying the hold invoice is a wallet it has not got yet (M3.2).
  // Without this line a free round and a funded entry read identically, which is
  // the thing letter 15 exists to stop.
  //
  // THE WORD IS THE NODE'S. `Client.join` keeps the `x-hold` the node answered
  // when it took the entry; a page that printed "not paid" as a constant would
  // be reporting its own assumption as the player's balance.
  const funding = stakeLine(stake);
  // AND WHO THE OTHERS ARE, BY THE NAMES THEY CHOSE (M3.3-34): each from a
  // record its player signed (identity.js `namesOf`), never a key. A player the
  // entries keep no name for is counted, not stubbed. A named player who has not
  // driven yet is still in the round, so the count is the larger of the two.
  const shown = (Array.isArray(names) ? names : []).filter((x) => typeof x === 'string' && x);
  const n = 1 + Math.max(others | 0, shown.length);
  // THE FUNDING WORD IS ON EVERY BRANCH, and it was not: this returned early
  // for a lone player, so the one line a player sits looking at while they
  // wait for somebody else - the longest-lived line on the chip - was the one
  // that did not say the entry was unpaid. Its own test caught it.
  if (n <= 1) return '1 player · waiting' + funding;
  // A PAGE THAT IS BEING SENT TRUCKS AND DRAWING NONE SAYS SO. Without this
  // the line reads the same as a page that is drawing them, which is what
  // made the 11:51 retest a guess: five players on the chip, one truck on the
  // screen, and no number between them.
  const where = at ? ` · other at ${Math.round(at.x)},${Math.round(at.z)} m` : '';
  const who = shown.length ? ': ' + shown.join(', ') + (n - 1 > shown.length ? ` +${n - 1 - shown.length} more` : '') : '';
  return n + ' players in this round' + who + (stalled ? ' · none drawn' : '') + where + funding;
}

/**
 * WHAT THE ENTRY COST, IN THE WORDS THE NODE USED.
 *
 * `free round` is a round that asks no stake - there is nothing to pay and nothing was dealt.
 *
 * A STAKE IS COUNTED, NOT NAMED (23.1 step 5): "not yet counted" until `stakeSeenBy` has asked the
 * settlement entries, then "stake seen by N of M nodes (T needed)", with the entries that did not answer
 * named and "committed" only at N >= T. A signer node sees a stake when it has verified its federation
 * lock. There used to be a second source here - the node's join-time `x-hold` word, which named a
 * hold invoice's state and its reason for having none - and it went with the hold invoice, which was
 * the withdrawn Lightning custody's (§23.6, RULED 2026-09-22 22:59).
 */
export function stakeLine(stake, nowMs = Date.now()) {
  if (!stake) return '';
  if (stake.free) return ' · free round';
  if (!stake.dealt) return '';
  const s = stake.seen;
  if (s && typeof s.seen === 'number') {
    return ` · stake seen by ${s.seen} of ${s.of} nodes (${s.needed} needed)`
      + (s.unanswered ? `, ${s.unanswered} did not answer` : '')
      + (s.committed ? ' · committed' : '')
      + settlementLine(s.settlement, nowMs);
  }
  return ' · stake dealt, not yet counted';
}

/**
 * WHERE THE STAKE STANDS AFTER THE RUN, in the settlement entries' words (MF
 * item 14): "the player is waiting on other people's machines and must be told
 * so, with the refund path visible the whole time". `s` is `settlementBy`'s
 * answer. Nothing is added until the entries have a result to wait on - before
 * that the count above is the whole story.
 *
 * SETTLED says the run lost the stake, and no more: where a settled stake goes
 * next is a ruling still open, and the chip does not claim it.
 */
export function settlementLine(s, nowMs = Date.now()) {
  if (!s || !s.answered) return '';
  // WHERE THE RUN'S RESULT STANDS, AND NOTHING ABOUT A HOLD. The hold's own states - SETTLED, CANCELLED,
  // EXPIRED - and the height a hold refunded itself at were the withdrawn Lightning custody's, and the signer nodes no longer
  // report them (§23.6). A lock's money moves in the one settlement, which this chip does not narrate.
  if (s.finality === 'SUSPENDED') return ' · suspended by an objection';
  if (s.finality === 'FINAL') return ' · final: the committee is settling it';
  if (s.finality === 'PROVISIONALLY_FINAL' && Number.isFinite(s.windowClosesAtMs)) {
    const left = Math.max(0, Math.ceil((s.windowClosesAtMs - nowMs) / 1000));
    return ` · waiting for the objection window, ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  }
  return '';
}
