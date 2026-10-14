// ACHIEVEMENTS AND BADGES (kanban #362, docs/PLATFORM-RESEARCH.md item 13: "awarded from signed results: collectible status
// on the player's own Nostr identity"). A badge is a line of status a seat hands a player for what the player already did -
// a first win, five rounds played, a perfect run, a place on a closed week's board - and it is published as NIP-58 events
// signed by the seat (arena-node/src/nostr-badges.js). This file holds WHAT the badges are and WHO earned them; it signs
// nothing and reads no store.
//
// THE SAME LAW AS THE SEASON (season.js): PRESENTATION, NOT AUTHORITY. A badge moves no sat and decides no round. And it
// adds nothing up of its own: who played a round, who won it and what a run scored are read through season() - one round
// at a time for the round badges, a closed week for the board badge - so a badge can never say a player won a round that
// the season board says they did not. Every amount and result season() reads is one the caller read as FINAL and settled.
//
// AND EVERY SEAT HANDED THE SAME ROUNDS AWARDS THE SAME BADGES WITH THE SAME EVIDENCE. No randomness, no clock but the
// `nowMs` handed in, the rounds read in round-id order, a player's rounds in start order (then id), the awards in catalogue
// order, then player key, then scope. The evidence of a round badge is the EARLIEST rounds that earned it, never the
// latest, so a later round cannot change what an award already names.
//
// A BADGE GOES TO AN IDENTITY, NEVER TO A ROUND KEY. Each tab joins under a fresh round key; a badge on one would be status
// on a key nobody keeps. The caller (season-read.js) maps every entry to its player - a head-to-head identity the
// identity key signed for, else the identity the round key's signed lobby record names, else the round key - and names the
// entry's round key beside it (`roundKey`). An entry whose player IS its round key, or that names no round key, earns
// nothing. (A lobby record's identity is the round key's claim, season.js SEASON_UNCHECKED says: a player can add its own
// results to an identity and can take none away - so the most a false claim does is hand somebody else a badge it won.)
import { season, DAY_MS } from './season.js';
import { DELIVERED } from './payout.js';

/** The catalogue's version: a changed rule is a NEW badge with a new `d`, never an old `d` that now means something else. */
export const BADGES_VERSION = 1;

export const WEEK_MS = 7 * DAY_MS;
/**
 * THE FIRST MONDAY OF THE EPOCH, 00:00 UTC (1970-01-05): every board week starts on a Monday at midnight UTC, as an ISO
 * week does. A week aligned to whole UTC weeks is the same week on every seat, whatever its clock reads inside it - a
 * week counted back from "now" would be a different window on each seat and on each tick, and no two seats would agree on
 * who stood third.
 */
export const WEEK_ZERO_MS = Date.UTC(1970, 0, 5);

/**
 * A PERFECT RUN of Tick Tock, Next Block (`nextblock`): a DELIVERED run scoring 1000 points or more. The score a nextblock
 * core signs is 1000 · E · T · C in units of 1e-5 points (nextblock/src/rules/score.js SCORE_SCALE): E (exposure) and C
 * (cargo) at most 1, T (time) 1 at par (30 s) and up to 1.5 faster. 1000 points is the full exposure and the full bed
 * delivered at par time: nothing left on the table but speed. A core from before the 1e-5 scale signed whole points,
 * whose most is 1500 - under this line, so an old run earns no perfect-run badge rather than a cheap one.
 */
export const PERFECT_RUN_GAME = 'nextblock';
export const PERFECT_RUN_SCORE = 100000000;

/**
 * THE CATALOGUE. Each badge: `d` (its NIP-58 identifier, stable - lowercase letters, digits and dashes, no colon, so a
 * client splitting an `a` tag `30009:<pubkey>:<d>` on ':' reads it whole), a name, a description, an image path (relative
 * to the issuing seat's public base), and its rule as data:
 *   first-win        the player's first win in a game: rank 1 or paid more than staked, as season() counts a win
 *   rounds-played    `rounds` rounds of a game played
 *   delivered-score  a DELIVERED run of `game` scoring `minScore` or more
 *   season-top       rank 1 to `top` on a closed week's board of a game, when that board ranks `minPlayers` or more
 * The three round rules count STAKED entries only: a free round costs nothing to play alone, and a solo DELIVERED run is a
 * win by rank (season.js), so a badge from free rounds could be farmed by one tab in a minute. The board badge is the
 * board as /season shows it, free rounds and all - and a board of fewer than three players hands no podium (one player
 * alone would be "top 3" of a board of one).
 */
export const BADGES = Object.freeze([
  { d: 'arena-first-win', name: 'First win', description: 'Won a staked round of a game for the first time.',
    image: '/badge-image/arena-first-win.svg', rule: 'first-win' },
  { d: 'arena-five-rounds', name: 'Five rounds', description: 'Played five staked rounds of a game.',
    image: '/badge-image/arena-five-rounds.svg', rule: 'rounds-played', rounds: 5 },
  { d: 'arena-perfect-run', name: 'Perfect run', description: 'Delivered a staked Tick Tock, Next Block run scoring 1000 points or more.',
    image: '/badge-image/arena-perfect-run.svg', rule: 'delivered-score', game: PERFECT_RUN_GAME, minScore: PERFECT_RUN_SCORE },
  { d: 'arena-season-top-3', name: 'Season top 3', description: 'Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).',
    image: '/badge-image/arena-season-top-3.svg', rule: 'season-top', top: 3, minPlayers: 3 },
].map((b) => Object.freeze(b)));

const HEX64 = /^[0-9a-f]{64}$/;
const D = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE = /^\/[a-z0-9][a-z0-9/._-]*$/;
const RULES = new Set(['first-win', 'rounds-played', 'delivered-score', 'season-top']);
const posInt = (n) => Number.isSafeInteger(n) && n >= 1;

/** Whether a catalogue stands: every `d` well formed and once, every rule known with its numbers. `{ ok }` or `{ ok: false, why }`. */
export function checkCatalogue(catalogue) {
  if (!Array.isArray(catalogue)) return { ok: false, why: 'a catalogue is a list of badges' };
  const seen = new Set();
  for (const b of catalogue) {
    if (!b || typeof b !== 'object') return { ok: false, why: 'that is not a badge' };
    if (!D.test(String(b.d))) return { ok: false, why: `a badge's d is lowercase letters, digits and dashes: ${b.d}` };
    if (seen.has(b.d)) return { ok: false, why: `two badges share the d ${b.d}` };
    seen.add(b.d);
    if (typeof b.name !== 'string' || !b.name || typeof b.description !== 'string' || !b.description)
      return { ok: false, why: `badge ${b.d} has no name or description` };
    if (!IMAGE.test(String(b.image))) return { ok: false, why: `badge ${b.d}'s image is a path from the issuer's base` };
    if (!RULES.has(b.rule)) return { ok: false, why: `badge ${b.d} has no known rule` };
    if (b.rule === 'rounds-played' && !posInt(b.rounds)) return { ok: false, why: `badge ${b.d} counts a whole number of rounds` };
    if (b.rule === 'delivered-score' && (typeof b.game !== 'string' || !b.game || !Number.isSafeInteger(b.minScore)))
      return { ok: false, why: `badge ${b.d} names a game and a whole score` };
    if (b.rule === 'season-top' && (!posInt(b.top) || !posInt(b.minPlayers))) return { ok: false, why: `badge ${b.d} names a top and a least board` };
  }
  return { ok: true };
}

/**
 * THE LAST WHOLE UTC WEEK THAT HAS CLOSED BY `nowMs`: `{ fromMs, toMs }`, Monday 00:00 UTC to the next, `toMs` <= `nowMs`;
 * null before the first one. The caller decides how long after a week's end it reads the week (a round started at 23:59 on
 * Sunday settles after midnight); this function only aligns.
 */
export function lastClosedWeek(nowMs) {
  const t = Number(nowMs);
  if (!Number.isSafeInteger(t)) return null;
  const k = Math.floor((t - WEEK_ZERO_MS) / WEEK_MS);
  if (k < 1) return null;
  return { fromMs: WEEK_ZERO_MS + (k - 1) * WEEK_MS, toMs: WEEK_ZERO_MS + k * WEEK_MS };
}

const startOf = (r) => {
  const v = r && r.startMs;
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
};
const lower = (x) => String(x || '').toLowerCase();
/** Whether every one of a player's entries in a round names a round key that is not the player: the player is an identity there. */
const asIdentity = (entries, player) => entries.length > 0
  && entries.every((e) => HEX64.test(lower(e.roundKey)) && lower(e.roundKey) !== player);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * WHO EARNED WHICH BADGE, from one game's rounds.
 *
 * `game`: `{ name, ids }` - the game's name (the catalogue's perfect run names one) and its ids in hex (a game's versions are
 * several ids, as on a season). `rounds`: season() rounds (season.js), each entry with its `roundKey` beside its `player` -
 * the FINAL results and settled amounts the caller read. `nowMs`: the clock, for the board badge alone - its window is the
 * last whole UTC week closed by `nowMs`; without it no board badge is looked for.
 *
 * Answers `{ ok, awards }`, each `{ d, player, game, scope, evidence }`: `scope` is what makes an award ONE award - the game
 * for a round badge (once per player and game, however many more rounds would earn it again), the game and the week for the
 * board badge - and `evidence` names what earned it: `{ rounds: [round id, ...] }`, the earliest that did, or
 * `{ window: { fromMs, toMs }, rank }`.
 */
export function badgesEarned({ game, rounds, nowMs } = {}, catalogue = BADGES) {
  const cat = checkCatalogue(catalogue);
  if (!cat.ok) return cat;
  if (!game || typeof game.name !== 'string' || !game.name) return { ok: false, why: 'badges are earned in a game, named' };
  const ids = [...new Set((Array.isArray(game.ids) ? game.ids : []).map(lower))].sort();
  if (!ids.length || ids.some((g) => !HEX64.test(g))) return { ok: false, why: 'a game is named by its ids in hex' };
  if (!Array.isArray(rounds)) return { ok: false, why: 'no rounds to award from' };
  const name = game.name;
  const awards = [];

  // 1. EACH ROUND ON ITS OWN, as season() reads it: the copies of one round handed in (a repeat counts once, two different
  // accounts count neither - season()'s rule), a VOID round, a refunded or unsettled entry: all left to season(), so a
  // round is "played" and "won" here exactly when the board says so.
  const byId = new Map();
  for (const r of rounds) {
    const id = lower(r && r.roundId);
    if (!HEX64.test(id)) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }
  const played = new Map();                      // player -> [{ id, at, win, delivered }]
  for (const id of [...byId.keys()].sort()) {
    const copies = byId.get(id);
    const at = startOf(copies[0]);
    if (at === null) continue;
    const s = season(copies, { games: ids, fromMs: at, toMs: at + 1n });
    if (!s.ok || s.rounds !== 1) continue;
    const entries = Array.isArray(copies[0].entries) ? copies[0].entries : [];
    for (const row of s.rows) {
      const mine = entries.filter((e) => e && lower(e.player) === row.player);
      if (!asIdentity(mine, row.player)) continue;
      if (!mine.some((e) => typeof e.stakeMsat === 'bigint' && e.stakeMsat > 0n)) continue;
      // THE BEST DELIVERED SCORE of a settled entry: a run that did not deliver, or whose amount is not signed, is no run here
      let delivered = null;
      for (const e of mine) {
        if (e.outcome !== DELIVERED || e.payoutMsat === null || e.payoutMsat === undefined || !Number.isSafeInteger(e.score)) continue;
        if (delivered === null || e.score > delivered) delivered = e.score;
      }
      if (!played.has(row.player)) played.set(row.player, []);
      played.get(row.player).push({ id, at, win: row.wins === 1, delivered });
    }
  }

  // 2. THE ROUND BADGES: each player's rounds in start order, then round id - the earliest that earn a badge are its evidence
  for (const [index, b] of catalogue.entries()) {
    if (b.rule === 'season-top') continue;
    if (b.rule === 'delivered-score' && b.game !== name) continue;
    for (const player of [...played.keys()].sort()) {
      const mine = [...played.get(player)].sort((x, y) => (x.at !== y.at ? (x.at < y.at ? -1 : 1) : order(x.id, y.id)));
      let evidence = null;
      if (b.rule === 'first-win') { const w = mine.find((x) => x.win); if (w) evidence = [w.id]; }
      if (b.rule === 'rounds-played' && mine.length >= b.rounds) evidence = mine.slice(0, b.rounds).map((x) => x.id);
      if (b.rule === 'delivered-score') { const p = mine.find((x) => x.delivered !== null && x.delivered >= b.minScore); if (p) evidence = [p.id]; }
      if (evidence) awards.push({ index, d: b.d, player, game: name, scope: name, evidence: { rounds: evidence } });
    }
  }

  // 3. THE BOARD BADGE: the last closed week's board, as /season builds it from the same rounds. A key that played any round
  // of the week as its own round key, or with no round key named, is no identity on that board and earns nothing from it.
  const week = nowMs === undefined || nowMs === null ? null : lastClosedWeek(nowMs);
  for (const [index, b] of catalogue.entries()) {
    if (b.rule !== 'season-top' || !week) continue;
    const s = season(rounds, { games: ids, fromMs: week.fromMs, toMs: week.toMs });
    if (!s.ok || s.rows.length < b.minPlayers) continue;
    const bare = new Set();
    for (const r of rounds) {
      const at = startOf(r);
      if (at === null || at < BigInt(week.fromMs) || at >= BigInt(week.toMs) || !Array.isArray(r.entries)) continue;
      for (const e of r.entries) if (e && !asIdentity([e], lower(e.player))) bare.add(lower(e.player));
    }
    const scope = `${name}@${new Date(week.fromMs).toISOString().slice(0, 10)}`;
    for (const row of s.rows) {
      if (row.rank > b.top || bare.has(row.player)) continue;
      awards.push({ index, d: b.d, player: row.player, game: name, scope, evidence: { window: { fromMs: week.fromMs, toMs: week.toMs }, rank: row.rank } });
    }
  }

  awards.sort((a, b) => a.index - b.index || order(a.player, b.player) || order(a.scope, b.scope));
  return { ok: true, awards: awards.map(({ index, ...a }) => a) };
}
