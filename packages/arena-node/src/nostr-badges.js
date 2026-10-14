// BADGES ON NOSTR (kanban #362, docs/PLATFORM-RESEARCH.md item 13): the badges protocol badges.js says a player earned, as
// NIP-58 events signed by this seat's node key - beside its signed round results (nostr-results.js), on the same clock.
//
// NIP-58, AS THIS FILE BUILDS IT (nostr-protocol/nips 58.md):
//   - A BADGE DEFINITION is kind 30009, a parameterized replaceable event: a `d` tag (MUST, the badge's unique name), and
//     MAY `name`, `description`, `image` (a URL, optionally "WIDTHxHEIGHT") and `thumb` tags. One per catalogue badge,
//     `d` the catalogue's, signed by the seat. No `thumb` (one image, served small). The `image` tag is there when the seat
//     has a public https base (ARENA_BADGE_IMAGE_BASE, else the first ARENA_REPLAY_PUBLIC address): the seat serves the
//     image itself at that base + the catalogue's path (GET /badge-image/<d>.svg); with no public base the tag is left out,
//     which NIP-58 allows, rather than naming a URL nobody can open. The image's size is not stated (it is an SVG).
//   - A BADGE AWARD is kind 8, a regular (not replaceable) event: exactly one `a` tag naming the definition,
//     `30009:<issuer pubkey>:<d>`, and one or more `p` tags, each an awarded pubkey (an optional relay hint after it, none
//     here). Awards are immutable and non-transferable (NIP-58), so each is issued once - kept in nostr_badges - and one
//     award names one player: a `p` per player would tie one player's award to another's evidence.
//   - ASSUMPTIONS, beyond what NIP-58 says: the content of both is the empty string (NIP-58's own examples carry none); the
//     award also carries `t` (the game's name), `evidence` (the round ids that earned it) or `window` (a board week, ISO
//     from and to) with `rank`, and NIP-31's `alt`. Tags NIP-58 does not name are ignored by a client that does not know
//     them, and a relay indexes single-letter tags only, so `evidence` and `window` cost nobody anything.
//   - THE PLAYER IS A NOSTR KEY. A `p` tag is an x-only secp256k1 key (BIP-340, 32 bytes): an identity that is not a point
//     on the curve could never be followed or shown, so it is awarded nothing.
//
// WHEN A BADGE IS AWARDED (with ARENA_NOSTR_BADGES=1; off, nothing is awarded and the doors say so):
//   - THE ROUND BADGES (first win, five rounds, a perfect run) once a round's settlement is ACCEPTED here - the moment its
//     Nostr result is built: every newly ACCEPTED round is read once, as the season board reads it (season-read.js
//     seasonRoundOf: FINAL results, the amounts its settlement paid, each entry under its identity), into a small ledger
//     (nostr_badge_rounds), and the game's ledger is handed to badgesEarned. The ledger is what keeps that cheap: reading a
//     round verifies every result signature it holds, and a game's history is read once, never on every settlement.
//   - THE BOARD BADGE (season top 3) once a whole UTC week has closed and BOARD_GRACE_MS more have passed (a round started at
//     Sunday 23:59 settles after midnight): this seat's own season of each game it hosts for that week, as /season shows it.
//     Each game's week is read once (nostr_badge_weeks).
// Each award - one badge, one player, one scope (a game, or a game's week) - is issued ONCE: the nostr_badges row is its
// key, so a restart, a second read of the ledger or a later round that would earn the same badge again issues nothing new.
//
// PUBLISHING reuses the results' path (nostr-results.js publishPass): to the relays in ARENA_NOSTR_PUBLISH, the definitions
// first, retried with backoff, at most `perMinute` events a minute, given up after `maxAttempts`. Kept events are served at
// GET /badges and GET /badge-definitions, published or not, so a client checks their ids and signatures itself.
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from './nostr-relay.js';
import { acceptedNotIn, publishPass } from './nostr-results.js';
import { BADGES, BADGES_VERSION, badgesEarned, checkCatalogue, lastClosedWeek } from '../../arena-protocol/src/badges.js';
import { seasonRoundsToJson, seasonRoundsFromJson } from '../../arena-protocol/src/season.js';

export const BADGE_DEFINITION_KIND = 30009;
export const BADGE_AWARD_KIND = 8;
/**
 * WHEN THE CATALOGUE'S DEFINITIONS ARE DATED: the catalogue's own date (version 1, 2026-10-14), not the hour a seat started -
 * so a seat signs the same definition, byte for byte, on every start. A definition is replaceable (newest per seat and `d`),
 * and a later version of the catalogue dates its own - in the past when it ships: a relay refuses an event dated more than
 * a few minutes ahead of its clock (ours: 15 min), and a date set to the release day is ahead of every clock west of it.
 */
export const BADGES_AT_S = Math.floor(Date.UTC(2026, 9, 14) / 1000);
/** How long after a week closes its board is read for the board badge: two hours, for the rounds started at its end to settle. */
export const BOARD_GRACE_MS = 2 * 3600 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const hexOf = (b) => Buffer.from(b).toString('hex');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Whether badges are on: ARENA_NOSTR_BADGES=1. Off by default. */
export const badgesOn = (v = process.env.ARENA_NOSTR_BADGES) => String(v ?? '').trim() === '1';

/** The public https base a definition's image is named under, without a trailing slash; null: none. */
export const imageBaseOf = (v) => {
  const u = String(v || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s"']+$/.test(u) ? u : null;
};

/** Whether `hex` is a Nostr key: 32 bytes x-only, the x of a point on secp256k1 (BIP-340 lift_x). */
export function isNostrKey(hex) {
  const h = String(hex || '');
  if (!HEX64.test(h)) return false;
  try { schnorr.utils.lift_x(BigInt(`0x${h}`)); return true; } catch { return false; }
}

const sign = (e, secret) => {
  e.id = eventId(e);
  e.sig = hexOf(schnorr.sign(bytesOf(e.id), secret, new Uint8Array(32)));
  return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
};

/** A definition's tags: d, name, description, image (with a base), and NIP-31's alt. */
export function definitionTags(badge, { imageBase = null } = {}) {
  const tags = [['d', badge.d], ['name', badge.name], ['description', badge.description]];
  const base = imageBaseOf(imageBase);
  if (base) tags.push(['image', `${base}${badge.image}`]);
  tags.push(['alt', `Bitcoin Arena badge: ${badge.name}`]);
  return tags;
}

/** THE SIGNED BADGE DEFINITION (kind 30009): deterministic - the same badge, key and base give the same event. */
export function buildDefinitionEvent({ badge, secret, imageBase = null, createdAt = BADGES_AT_S }) {
  return sign({ pubkey: hexOf(schnorr.getPublicKey(secret)), created_at: createdAt, kind: BADGE_DEFINITION_KIND,
    tags: definitionTags(badge, { imageBase }), content: '' }, secret);
}

/** An award's tags: the `a` naming the definition, the `p` the player, then what earned it, the game and an alt. */
export function awardTags(award, { issuer, name }) {
  const tags = [['a', `${BADGE_DEFINITION_KIND}:${issuer}:${award.d}`], ['p', award.player]];
  if (award.evidence && Array.isArray(award.evidence.rounds)) tags.push(['evidence', ...award.evidence.rounds]);
  if (award.evidence && award.evidence.window) {
    const w = award.evidence.window;
    tags.push(['window', new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString()], ['rank', String(award.evidence.rank)]);
  }
  tags.push(['t', String(award.game)], ['alt', `Bitcoin Arena badge awarded: ${name || award.d} (${award.game})`]);
  return tags;
}

/**
 * THE SIGNED BADGE AWARD (kind 8), dated `atMs` - when it was awarded. Refused, by a throw, for a player that is not a Nostr
 * key: a badge on a key nobody can hold is no badge.
 */
export function buildAwardEvent({ award, secret, atMs, catalogue = BADGES }) {
  if (!isNostrKey(award.player)) throw new Error('a badge is awarded to a Nostr key: 32 bytes x-only, on the curve');
  const b = catalogue.find((x) => x.d === award.d);
  if (!b) throw new Error(`no badge ${award.d} in the catalogue`);
  const issuer = hexOf(schnorr.getPublicKey(secret));
  return sign({ pubkey: issuer, created_at: Math.floor(Number(atMs) / 1000), kind: BADGE_AWARD_KIND,
    tags: awardTags(award, { issuer, name: b.name }), content: '' }, secret);
}

/** A badge's image, drawn: a medal in the badge's colour with its mark and name. Plain SVG, no script, no outside reference. */
const LOOK = { 'arena-first-win': ['#f7931a', '1st'], 'arena-five-rounds': ['#3aa0ff', '5'], 'arena-perfect-run': ['#ffd166', '1000'],
  'arena-season-top-3': ['#b06cff', 'TOP 3'] };
export function badgeImage(badge) {
  const [colour, mark] = LOOK[badge.d] || ['#8a96a8', '*'];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const size = mark.length > 3 ? 44 : 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`
    + `<rect width="256" height="256" rx="48" fill="#07090d"/>`
    + `<circle cx="128" cy="112" r="78" fill="${colour}"/><circle cx="128" cy="112" r="62" fill="none" stroke="#07090d" stroke-width="6" opacity=".35"/>`
    + `<text x="128" y="${112 + size / 3}" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="${size}" fill="#07090d">${esc(mark)}</text>`
    + `<text x="128" y="230" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="24" fill="#e8edf3">${esc(badge.name)}</text></svg>`;
}

// THE LEDGER'S ROUNDS ON DISK: season.js's wire form, with each entry's round key beside it (the wire form drops it)
const ledgerJson = (r) => {
  const [j] = seasonRoundsToJson([r]);
  j.entries = j.entries.map((e, i) => ({ ...e, roundKey: r.entries[i].roundKey ?? null }));
  return JSON.stringify(j);
};
const ledgerRound = (text) => {
  const j = JSON.parse(text);
  const [r] = seasonRoundsFromJson([j]);
  if (r && Array.isArray(r.entries)) r.entries = r.entries.map((e, i) => ({ ...e, roundKey: (j.entries[i] && j.entries[i].roundKey) ?? null }));
  return r;
};

/**
 * THE SEAT'S BADGE BOOK.
 *   db         the round store's database (the nostr_badge_* tables are made here)
 *   secret     the node's identity secret (32 bytes)
 *   on         whether badges are awarded at all (ARENA_NOSTR_BADGES); off, the book awards nothing and keeps no clock
 *   relays     where to publish (publishRelays()); none: awards are kept and served, nothing is sent
 *   roundOf    hex round id -> { ok: true, game: { name, id }, round } (round: season-read.js seasonRoundOf) | { ok: false, status, why }
 *   settled    hex round id -> whether its settlement stands ACCEPTED (round.settlementState)
 *   games      () -> [{ name, ids }]: the games this seat hosts, a name with its ids
 *   seasonOf   ({ name, ids }, { fromMs, toMs }) -> season rounds of that game in that window (season-read.js seasonRounds)
 *   imageBase  the public https base the definitions' images are named under (null: no image tag)
 * Answers { definitions(), awardsOf(player), tick(), start(), stop() }.
 */
export function nostrBadges({ db, secret, on = false, relays = [], roundOf, settled = () => true, games = () => [], seasonOf = () => [],
  imageBase = null, catalogue = BADGES, perMinute = 30, tickMs = 60000, timeoutMs = 10000, maxAttempts = 10,
  lookbackMs = 90 * 86400000, now = () => Date.now(), connect, log = (l) => console.log(l) } = {}) {
  const cat = checkCatalogue(catalogue);
  if (!cat.ok) throw new Error(cat.why);
  db.exec(`CREATE TABLE IF NOT EXISTS nostr_badge_rounds (round_id TEXT PRIMARY KEY, game TEXT, round TEXT, made_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS nostr_badge_rounds_game ON nostr_badge_rounds (game);
    CREATE TABLE IF NOT EXISTS nostr_badge_weeks (game TEXT NOT NULL, from_ms INTEGER NOT NULL, awarded INTEGER NOT NULL, made_ms INTEGER NOT NULL,
      PRIMARY KEY (game, from_ms));
    CREATE TABLE IF NOT EXISTS nostr_badges (d TEXT NOT NULL, player TEXT NOT NULL, scope TEXT NOT NULL, game TEXT NOT NULL, evidence TEXT NOT NULL,
      event TEXT NOT NULL, made_ms INTEGER NOT NULL, published_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0,
      relays TEXT NOT NULL DEFAULT '{}', why TEXT, PRIMARY KEY (d, player, scope));
    CREATE INDEX IF NOT EXISTS nostr_badges_player ON nostr_badges (player);
    CREATE TABLE IF NOT EXISTS nostr_badge_defs (id TEXT PRIMARY KEY, d TEXT NOT NULL, event TEXT NOT NULL, made_ms INTEGER NOT NULL,
      published_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0, relays TEXT NOT NULL DEFAULT '{}', why TEXT);`);
  const q = {
    putRound: db.prepare('INSERT OR IGNORE INTO nostr_badge_rounds (round_id, game, round, made_ms) VALUES (?, ?, ?, ?)'),
    ledger: db.prepare('SELECT round FROM nostr_badge_rounds WHERE game = ? AND round IS NOT NULL ORDER BY round_id'),
    week: db.prepare('SELECT 1 FROM nostr_badge_weeks WHERE game = ? AND from_ms = ?'),
    putWeek: db.prepare('INSERT OR IGNORE INTO nostr_badge_weeks (game, from_ms, awarded, made_ms) VALUES (?, ?, ?, ?)'),
    award: db.prepare(`INSERT OR IGNORE INTO nostr_badges (d, player, scope, game, evidence, event, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    has: db.prepare('SELECT 1 FROM nostr_badges WHERE d = ? AND player = ? AND scope = ?'),
    of: db.prepare('SELECT * FROM nostr_badges WHERE player = ? ORDER BY made_ms, d, scope'),
    putDef: db.prepare('INSERT OR IGNORE INTO nostr_badge_defs (id, d, event, made_ms) VALUES (?, ?, ?, ?)'),
    dueDefs: db.prepare('SELECT id AS key, event, attempts, relays FROM nostr_badge_defs WHERE published_ms IS NULL AND attempts < ? AND next_ms <= ? ORDER BY d LIMIT ?'),
    dueAwards: db.prepare(`SELECT d || ' ' || player || ' ' || scope AS key, d, player, scope, event, attempts, relays FROM nostr_badges
      WHERE published_ms IS NULL AND attempts < ? AND next_ms <= ? ORDER BY made_ms, d, player, scope LIMIT ?`),
    markDef: db.prepare('UPDATE nostr_badge_defs SET published_ms = ?, attempts = ?, next_ms = ?, relays = ?, why = ? WHERE id = ?'),
    markAward: db.prepare('UPDATE nostr_badges SET published_ms = ?, attempts = ?, next_ms = ?, relays = ?, why = ? WHERE d = ? AND player = ? AND scope = ?'),
    defOf: db.prepare('SELECT published_ms FROM nostr_badge_defs WHERE id = ?'),
  };
  // THE DEFINITIONS, built once from the catalogue - the same bytes on every start - and kept by id: a new image base or a new
  // catalogue is a new id, published anew; the same one is never sent twice
  const defs = catalogue.map((badge) => buildDefinitionEvent({ badge, secret, imageBase }));
  const startedMs = now();
  if (on) for (const e of defs) q.putDef.run(e.id, e.tags[0][1], JSON.stringify(e), startedMs);
  const issuer = hexOf(schnorr.getPublicKey(secret));
  const roundRules = catalogue.filter((b) => b.rule !== 'season-top');
  const boardRules = catalogue.filter((b) => b.rule === 'season-top');
  const sentAt = [];
  let timer = null, busy = false, stopped = false;

  /** Keep each new award, signed: one per (badge, player, scope), the first one kept stands. Answers how many were new. */
  const keepAwards = (awards) => {
    let made = 0;
    for (const a of awards) {
      if (q.has.get(a.d, a.player, a.scope)) continue;
      if (!isNostrKey(a.player)) continue;               // no Nostr key, no badge (and nothing kept: it is asked again, cheaply)
      const event = buildAwardEvent({ award: a, secret, atMs: now(), catalogue });
      const r = q.award.run(a.d, a.player, a.scope, a.game, JSON.stringify(a.evidence), JSON.stringify(event), now());
      if (r.changes) { made++; log(`[badges] ${a.d} to ${a.player.slice(0, 16)} in ${a.scope} (${event.id.slice(0, 16)})`); }
    }
    return made;
  };

  /** 1. THE ROUND BADGES: each newly ACCEPTED round into the ledger, then each game it touched handed to badgesEarned. */
  const awardRounds = () => {
    const touched = new Set();
    for (const rid of acceptedNotIn(db, 'nostr_badge_rounds', startedMs - lookbackMs)) {
      if (!settled(rid)) continue;
      let got;
      try { got = roundOf(rid); } catch (e) { got = { ok: false, why: e.message }; }
      // A ROUND THIS SEAT SAYS NOTHING OF (a game it does not host, a free market): kept with no game, never read again
      if (!got || !got.ok || !got.round) { q.putRound.run(rid, null, null, now()); continue; }
      q.putRound.run(rid, got.game.name, ledgerJson(got.round), now());
      touched.add(got.game.name);
    }
    let made = 0;
    for (const name of [...touched].sort()) {
      const rounds = q.ledger.all(name).map((r) => ledgerRound(r.round));
      const ids = [...new Set(rounds.map((r) => String(r.gameId)))];
      const earned = badgesEarned({ game: { name, ids }, rounds }, roundRules);
      if (earned.ok) made += keepAwards(earned.awards);
      else log(`[badges] ${name}: ${earned.why}`);
    }
    return made;
  };

  /** 2. THE BOARD BADGE: each hosted game's last closed week, read once, BOARD_GRACE_MS after it closed. */
  const awardBoards = () => {
    if (!boardRules.length) return 0;
    const at = now() - BOARD_GRACE_MS;
    const week = lastClosedWeek(at);
    if (!week) return 0;
    let made = 0;
    for (const g of games()) {
      if (q.week.get(g.name, week.fromMs)) continue;
      const rounds = seasonOf(g, week);
      const earned = badgesEarned({ game: { name: g.name, ids: g.ids }, rounds, nowMs: at }, boardRules);
      const n = earned.ok ? keepAwards(earned.awards) : 0;
      if (!earned.ok) log(`[badges] ${g.name}: ${earned.why}`);
      q.putWeek.run(g.name, week.fromMs, n, now());
      made += n;
    }
    return made;
  };

  /** 3. PUBLISHING: the definitions first, then the awards, at most perMinute events a minute (publishPass). */
  const publish = async () => {
    if (!relays.length) return 0;
    const t = now();
    while (sentAt.length && sentAt[0] <= t - 60000) sentAt.shift();
    let budget = Math.max(0, perMinute - sentAt.length);
    let sent = 0;
    for (const [due, mark, named] of [[q.dueDefs, (o, r) => q.markDef.run(o.publishedMs, o.attempts, o.nextMs, JSON.stringify(r.relays), o.why, r.key), 'definition'],
      [q.dueAwards, (o, r) => q.markAward.run(o.publishedMs, o.attempts, o.nextMs, JSON.stringify(r.relays), o.why, r.d, r.player, r.scope), 'award']]) {
      if (!budget) break;
      const rows = due.all(maxAttempts, t, budget).map((r) => ({ ...r, event: JSON.parse(r.event), relays: JSON.parse(r.relays), attempts: Number(r.attempts) }));
      if (!rows.length) continue;
      for (const _ of rows) sentAt.push(t);
      budget -= rows.length;
      sent += rows.length;
      const outcomes = await publishPass(rows, relays, { connect, timeoutMs, now, maxAttempts });
      rows.forEach((r, i) => {
        const o = outcomes[i];
        mark(o, r);
        if (o.done) log(`[badges] ${named} ${r.event.id.slice(0, 16)} published: ${relays.length - o.refused.length} of ${relays.length} relays took it`);
        else if (o.attempts >= maxAttempts) log(`[badges] ${named} ${r.event.id.slice(0, 16)} given up: ${o.why}`);
      });
    }
    return sent;
  };

  const tick = async () => {
    if (!on || busy || stopped) return { awarded: 0, sent: 0 };
    busy = true;
    try {
      const awarded = awardRounds() + awardBoards();
      return { awarded, sent: await publish() };
    } catch (e) {
      log(`[badges] ${e.message}`);
      return { awarded: 0, sent: 0, why: e.message };
    } finally { busy = false; }
  };

  const awardRow = (r) => ({ d: r.d, game: r.game, scope: r.scope, evidence: JSON.parse(r.evidence), event: JSON.parse(r.event),
    awardedMs: Number(r.made_ms), publishedMs: r.published_ms === null ? null : Number(r.published_ms) });

  return {
    on,
    issuer,
    version: BADGES_VERSION,
    /** The catalogue's signed definitions, in catalogue order, each with whether it reached every relay. */
    definitions: () => defs.map((e) => { const row = q.defOf.get(e.id); return { event: e, publishedMs: row && row.published_ms !== null ? Number(row.published_ms) : null }; }),
    /** The awards this seat issued to `player` (64 hex), oldest first. */
    awardsOf: (player) => q.of.all(String(player || '').toLowerCase()).map(awardRow),
    tick,
    start() {
      if (timer || !on) return;
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
  };
}
