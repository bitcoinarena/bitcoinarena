// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S BADGES ON THE SEASON BOARD (docs/PLATFORM-RESEARCH.md items 13 and 1, presentation): the small
// icons after a name on the board, from the seats that award NIP-58 badges (arena-node nostr-badges.js, served at
// GET /badges?player=<identity> and GET /badge-definitions; protocol badges.js says who earned what).
//
// THE SAME LAW AS THE BOARD: PRESENTATION, NOT AUTHORITY. A badge moves no sat and ranks nobody; this module only reads what
// the seats answered, keeps what belongs to the game on screen and says it in words. It checks no signature - a badge is a
// line of status, and the page is not where status is proven (a Nostr client checks the events' ids and signatures itself).
//
// WHICH SEATS: a seat awards badges only with ARENA_NOSTR_BADGES (today seats 1 and 7); every other seat answers `on: false`.
// The board's own seats are asked once each for GET /badge-definitions, and the ones that answer `on: true` are the badge
// seats of this board. Each seat awards from the rounds IT holds (the round badges come from the rounds its committees
// settled), so two badge seats can each hold a "first win" for the same player and game, or one holds it and the other does
// not: a player's awards are asked of every badge seat and MERGED BY (d, scope) - one award shown once, whichever seat
// issued it. Where two seats define the same badge, the first seat in the board's order wins (its name, its words, its image).
//
// BOUNDED: one GET /badge-definitions per seat and one GET /badges per player and badge seat, for the board's life (the
// book below), a few at a time; nothing asked once the board is closed, and a closed board's late answers dropped.
//
// DETERMINISTIC AND WITHOUT A DOM: the same answers give the same icons and words, so a test and the page agree. The network
// is reached only through the fetch handed in.

/** How long one seat is waited for, for its definitions or a player's awards: the board is drawn already, so not long. */
export const BADGES_ANSWER_MS = 8000;
/** How many badge requests run at once: a board of 100 rows fills in a few at a time, never in one burst of 100. */
export const BADGES_AT_ONCE = 4;
/** Icons drawn after one name at most: the catalogue has four, and a phone row has room for few more. */
export const BADGES_SHOWN = 5;

// A BADGE'S d, as the protocol catalogue writes it (badges.js D): lowercase letters, digits and dashes, so it is a safe
// part of a path (/badge-image/<d>.svg) and of a class name. A d that is not one is no badge here.
const BADGE_D = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BADGE_HEX64 = /^[0-9a-f]{64}$/;

/**
 * THE BUILT-IN GLYPH of each catalogue badge, for a definition that names no image (a seat with no public base leaves the
 * image tag out, which NIP-58 allows) or an image that does not load: the seat's own medal colours (nostr-badges.js LOOK)
 * and one mark that reads at 16 px. A badge not in the catalogue gets a grey dot.
 */
export const BADGE_GLYPHS = Object.freeze({
  'arena-first-win': Object.freeze({ colour: '#f7931a', mark: '1' }),
  'arena-five-rounds': Object.freeze({ colour: '#3aa0ff', mark: '5' }),
  'arena-perfect-run': Object.freeze({ colour: '#ffd166', mark: '★' }),
  'arena-season-top-3': Object.freeze({ colour: '#b06cff', mark: '3' }),
});
const BADGE_GLYPH_OTHER = Object.freeze({ colour: '#8a96a8', mark: '•' });
// THE ORDER ICONS STAND IN: the catalogue's, then any other badge by its d - the same order on every row and every draw
const BADGE_ORDER = Object.keys(BADGE_GLYPHS);

/** The path a seat answers one player's awards on. */
export function badgesPath(player) {
  return `/badges?player=${encodeURIComponent(String(player || '').toLowerCase())}`;
}

/** The path a seat serves a badge's image on (server.js GET /badge-image/<d>.svg), or null for a d that is not one. */
export function badgeImagePath(d) {
  return BADGE_D.test(String(d)) ? `/badge-image/${d}.svg` : null;
}

/** A badge's glyph: its colour and mark. */
export function badgeGlyph(d) {
  return BADGE_GLYPHS[d] || BADGE_GLYPH_OTHER;
}

const badgeTag = (event, name) => {
  const t = event && Array.isArray(event.tags) ? event.tags.find((x) => Array.isArray(x) && x[0] === name) : null;
  return t && typeof t[1] === 'string' ? t[1] : null;
};
const badgeCut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * ONE NIP-58 BADGE DEFINITION (kind 30009) as the page needs it: `{ d, name, description, image }` - `image` whether the
 * definition names one at all (the page then shows the issuing seat's own /badge-image/<d>.svg, never the URL in the tag:
 * the seat is the one place the page already reaches, through its route). A seat serves `{ event, publishedMs }`; a bare
 * event is read the same. Null for one with no well-formed d. The words are cut short: a seat's text never runs a row wide.
 */
export function readBadgeDefinition(def) {
  const event = def && typeof def === 'object' && def.event && typeof def.event === 'object' ? def.event : def;
  if (!event || typeof event !== 'object' || event.kind !== 30009) return null;
  const d = badgeTag(event, 'd');
  if (!d || !BADGE_D.test(d)) return null;
  const name = (badgeTag(event, 'name') || '').trim();
  const description = (badgeTag(event, 'description') || '').trim();
  return { d, name: badgeCut(name || d, 60), description: badgeCut(description, 200), image: !!badgeTag(event, 'image') };
}

/**
 * ONE PLAYER'S BADGES IN ONE GAME, merged from the badge seats' answers. `answers`: `[{ seat, answer }]` in the board's seat
 * order, each `answer` a GET /badges body (`{ player, on, awards, definitions }`). Kept: an answer that is `on: true` and
 * names this player; an award of the shown game (`award.game === game` - its round badges, and its weekly board's
 * top 3, whose scope is the game and the week) with a well-formed d and scope, whose event (when sent) names this player in
 * its `p` tag. Each (d, scope) once, the first seat's. Answers `{ player, count, badges }`: `count` the awards kept, and
 * `badges` one entry per d - `{ d, name, description, count, image, glyph, title }`, `image` the defining seat's
 * /badge-image URL (unrouted) or null - in the catalogue's order, at most BADGES_SHOWN.
 */
export function mergeBadgeAwards(answers, { player, game } = {}) {
  const who = String(player || '').toLowerCase();
  const kept = new Map();                        // `${d}\n${scope}` -> d
  const defs = new Map();                        // d -> { ...definition, seat }
  for (const { seat, answer } of Array.isArray(answers) ? answers : []) {
    if (!answer || typeof answer !== 'object' || answer.on !== true) continue;
    if (String(answer.player || '').toLowerCase() !== who) continue;
    for (const def of Array.isArray(answer.definitions) ? answer.definitions : []) {
      const r = readBadgeDefinition(def);
      if (r && !defs.has(r.d)) defs.set(r.d, { ...r, seat: String(seat || '').replace(/\/+$/, '') });
    }
    for (const a of Array.isArray(answer.awards) ? answer.awards : []) {
      if (!a || typeof a !== 'object' || !BADGE_D.test(String(a.d))) continue;
      if (typeof a.game !== 'string' || a.game !== game) continue;
      if (typeof a.scope !== 'string' || !a.scope) continue;
      // AN AWARD TO SOMEBODY ELSE is not this player's, whatever row it was asked for: a sent event names its player
      if (a.event && Array.isArray(a.event.tags) && !a.event.tags.some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === who)) continue;
      const k = `${a.d}\n${a.scope}`;
      if (!kept.has(k)) kept.set(k, a.d);
    }
  }
  const byD = new Map();
  for (const d of kept.values()) byD.set(d, (byD.get(d) || 0) + 1);
  const rank = (d) => { const i = BADGE_ORDER.indexOf(d); return i < 0 ? BADGE_ORDER.length : i; };
  const ds = [...byD.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const badges = ds.slice(0, BADGES_SHOWN).map((d) => {
    const def = defs.get(d) || { d, name: d, description: '', image: false, seat: '' };
    const count = byD.get(d);
    const image = def.image && /^https?:\/\//.test(def.seat) ? def.seat + badgeImagePath(d) : null;
    return { d, name: def.name, description: def.description, count, image, glyph: badgeGlyph(d), title: badgeTitle({ name: def.name, description: def.description, count }) };
  });
  return { player: who, count: kept.size, badges };
}

/** A badge's tooltip: its name, how often when more than once (a board's top 3 in two weeks), and what earned it. */
export function badgeTitle({ name, description = '', count = 1 }) {
  const head = `${name}${count > 1 ? ` ×${count}` : ''}`;
  return description ? `${head}: ${description}` : head;
}

/** The line under the board's header for the viewer's own badges in this game, or null with none. */
export function yourBadgesLine(merged) {
  const n = merged && Number.isSafeInteger(merged.count) ? merged.count : 0;
  return n > 0 ? `Your badges: ${n}` : null;
}

/**
 * THE BADGES OF ONE OPEN BOARD: what was asked, what came back, for the board's life - made when a board opens on a game
 * and closed when it closes (or opens on another game), so nothing is asked twice and nothing at all while it is closed.
 *
 * `nodes` the board's seats in order; `game` the game's name; `fetch` / `via` / `timeout` as fetchSeason takes them;
 * `onBadges(player, merged)` is called once per player when its badges are in (an empty merge too, so the page knows).
 * Answers `{ want(player), get(player), close(), seats(), asked }`: want() queues a player once (a second want is nothing),
 * get() is its merge or null while it is not in, seats() the badge seats once known, `asked` the requests made so far.
 */
export function badgeBook({ nodes = [], game, fetch, via = (u) => u, timeout, answerMs = BADGES_ANSWER_MS, atOnce = BADGES_AT_ONCE, onBadges = () => {} } = {}) {
  const list = [...new Set((Array.isArray(nodes) ? nodes : []).map((n) => String(n || '').replace(/\/+$/, '')).filter((n) => /^https?:\/\//.test(n)))];
  const got = new Map();                         // player -> merge, or null while asked
  const queue = [];
  const asked = { definitions: 0, badges: 0 };
  let running = 0, closed = false, onSeats = null, known = null;

  const ask = async (url) => {
    const signal = timeout ? timeout(answerMs) : undefined;
    const r = await fetch(via(url), { cache: 'no-store', signal });
    if (!r || !r.ok) throw new Error(`answered ${r ? r.status : 'nothing'}`);
    return r.json();
  };
  // THE BADGE SEATS, found once: every seat of the board asked for its definitions at the same time, the ones `on: true`
  // kept in the board's order. A seat that fails is no badge seat for this board's life - it is asked again on the next.
  const badgeSeats = () => {
    if (!onSeats) onSeats = Promise.all(list.map(async (seat) => {
      if (closed) return null;
      asked.definitions++;
      try { const a = await ask(`${seat}/badge-definitions`); return a && a.on === true ? seat : null; } catch { return null; }
    })).then((xs) => (known = xs.filter(Boolean)));
    return onSeats;
  };
  const run = async (player) => {
    const seats = await badgeSeats();
    const answers = await Promise.all(seats.map(async (seat) => {
      if (closed) return { seat, answer: null };
      asked.badges++;
      try { return { seat, answer: await ask(seat + badgesPath(player)) }; } catch { return { seat, answer: null }; }
    }));
    const merged = mergeBadgeAwards(answers, { player, game });
    got.set(player, merged);
    if (!closed) onBadges(player, merged);
  };
  const pump = () => {
    while (!closed && running < atOnce && queue.length) {
      const player = queue.shift();
      running++;
      run(player).catch(() => {}).finally(() => { running--; pump(); });
    }
  };
  return {
    want(player) {
      const p = String(player || '').toLowerCase();
      if (closed || !game || !BADGE_HEX64.test(p) || got.has(p)) return;
      got.set(p, null);
      queue.push(p);
      pump();
    },
    get: (player) => got.get(String(player || '').toLowerCase()) || null,
    seats: () => known,
    close() { closed = true; queue.length = 0; },
    get asked() { return { ...asked }; },
  };
}
