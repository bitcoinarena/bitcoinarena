// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LEADERBOARD (named the season board until) AS THE PAGE SHOWS IT (docs/PLATFORM-RESEARCH.md item 1, presentation): one game's board
// over the last 7, 30 or 90 days, from a seat's GET /season?game=<name>&days=<n>&scope=network.
//
// The seat built the board (protocol season.js, merged across seats by mergeSeasonAccounts: a round counts only when 3
// seats hand in byte-identical accounts of it), and the board is PRESENTATION, NOT AUTHORITY (0.11): nothing here ranks,
// adds up or pays. This module only turns the answer into lines - the rank and name as the seat gave them, the net in whole
// sats, the best score in the game's own unit, a header, and the viewer's own row marked - and refuses an answer that is
// not a board by name, so the page asks the next seat instead of drawing a broken one.
//
// NO FLOAT EVER TOUCHES AN AMOUNT. A seat sends msat as a decimal string; it is read as a BigInt, and a string that is not
// a whole number (a "1.5", an "1e3", an empty one) refuses the whole answer. The sats shown are the msat divided by 1000
// with the fraction dropped - the MAGNITUDE rounded down, so neither a win nor a loss is ever shown larger than it was
// (-1,999 msat is "-1 sat", not "-2 sat"); the exact msat stays on the row beside it.
//
// DETERMINISTIC AND WITHOUT A DOM: the same answer, title and viewer give the same rows, so a test and the page agree.
// The one function that talks to the network, fetchSeason, is handed its fetch.

/** The windows the page offers (protocol season.js takes 1 to 90 whole days; the seat keeps each one 30 s). */
export const SEASON_DAYS_CHOICES = [7, 30, 90];
/** How often an open season view asks again: the seat keeps a season 30 s (SEASON_KEEP_MS), so sooner reads the same. */
export const SEASON_POLL_MS = 30000;
/** How long one seat is waited for: a cold network season asks every other seat with an 8 s limit of its own. */
export const SEASON_ANSWER_MS = 12000;
/** Rows drawn at most; the viewer's own row is added below them when it ranks further down. */
export const SEASON_ROWS_SHOWN = 100;

// A GAME'S SCORE IN ITS OWN UNIT: Tick Tock, Next Block's core signs points in units of 1e-5 (nextblock rules/score.js
// SCORE_SCALE), and the result card prints them with five decimals (ResultSummary.cs Score: 8304450 is 83.04450). A game
// not named here shows the integer its core signed.
const SEASON_SCORE_DECIMALS = { nextblock: 5 };
const SEASON_HEX64 = /^[0-9a-f]{64}$/;
const SEASON_WHOLE = /^-?\d+$/;

/** The path a seat answers a season on: one game by name (every version the seat hosts under it), across the network. */
export function seasonPath(game, days) {
  return `/season?game=${encodeURIComponent(String(game || ''))}&days=${Number(days)}&scope=network`;
}

/** msat (a whole-number string, a BigInt or a safe integer) as the signed sats line: "+12 sat", "-3 sat", "0 sat". */
export function seasonSats(msat) {
  const m = seasonMsat(msat);
  if (m === null) return null;
  const whole = (m < 0n ? -m : m) / 1000n;
  const sign = whole === 0n ? '' : m < 0n ? '-' : '+';
  return `${sign}${seasonThousands(whole)} sat`;
}

/** A best score as the game's result card prints it, or an en dash when the player has none (a market's pick has no score). */
export function seasonScore(score, game) {
  if (score === null || score === undefined) return '\u2013';
  if (!Number.isSafeInteger(score)) return '\u2013';
  const places = SEASON_SCORE_DECIMALS[String(game || '')] || 0;
  if (!places) return String(score);
  const unit = 10 ** places;
  const a = Math.abs(score);
  return `${score < 0 ? '-' : ''}${Math.floor(a / unit)}.${String(a % unit).padStart(places, '0')}`;
}

function seasonMsat(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string' && SEASON_WHOLE.test(v.trim())) return BigInt(v.trim());
  return null;
}

function seasonThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function seasonCount(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * THE BOARD THE PAGE DRAWS, from one /season answer. `title` is the game as its tile names it ("Tick Tock, Next Block");
 * `viewer` the viewer's identity key(s) in hex - the key a round's lobby record names, which is who the season counts a
 * round under. Answers `{ ok: true, title, game, days, header, foot, players, nodes, rows, mine, more, empty }` - each row
 * `{ rank, player, name, rounds, wins, netMsat, net, sign, bestScore, best, mine }` - or `{ ok: false, why }` for an
 * answer that is not a board.
 */
export function seasonView(answer, { title = null, viewer = [], limit = SEASON_ROWS_SHOWN } = {}) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, why: 'that answer is not a season' };
  if (!Array.isArray(answer.rows)) return { ok: false, why: 'that season lists no rows' };
  const days = Number(answer.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { ok: false, why: 'that season names no window of 1 to 90 days' };
  const game = answer.game && typeof answer.game === 'object' && typeof answer.game.name === 'string' ? answer.game.name : null;
  const mineKeys = new Set((Array.isArray(viewer) ? viewer : [viewer]).map((k) => String(k || '').toLowerCase()).filter((k) => SEASON_HEX64.test(k)));
  const rows = [];
  for (const r of answer.rows) {
    if (!r || typeof r !== 'object') return { ok: false, why: 'a season row is not a row' };
    const player = String(r.player || '').toLowerCase();
    if (!SEASON_HEX64.test(player)) return { ok: false, why: 'a season row names no 32-byte player key' };
    if (!Number.isSafeInteger(r.rank) || r.rank < 1) return { ok: false, why: `the row of ${player.slice(0, 8)} has no rank` };
    if (!Number.isSafeInteger(r.rounds) || r.rounds < 0 || !Number.isSafeInteger(r.wins) || r.wins < 0)
      return { ok: false, why: `the row of ${player.slice(0, 8)} counts no rounds or wins` };
    const net = seasonMsat(r.netMsat);
    if (net === null) return { ok: false, why: `the row of ${player.slice(0, 8)} names no whole msat as its net` };
    const best = r.bestScore === null || r.bestScore === undefined ? null : r.bestScore;
    if (best !== null && !Number.isSafeInteger(best)) return { ok: false, why: `the row of ${player.slice(0, 8)} names a best score that is not a whole number` };
    // THE NAME AS THE ROUND RESULT SHOWS IT: the seat sends the player's own name, else the one made from its key; a row
    // without one is shown by its key's first 8 digits, as the result card does (ResultSummary.cs Who)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : player.slice(0, 8);
    rows.push({ rank: r.rank, player, name, rounds: r.rounds, wins: r.wins, netMsat: net.toString(), net: seasonSats(net),
      sign: net > 0n ? 1 : net < 0n ? -1 : 0, bestScore: best, best: seasonScore(best, game), mine: mineKeys.has(player) });
  }
  // THE SEAT'S ORDER, NOT OURS: season.js ranked the rows (net, wins, best score, then the key), and the page keeps that
  // order by rank - sorting again by anything else would be a second ranking beside the seat's
  rows.sort((a, b) => a.rank - b.rank);
  // ONLY THE PLAYERS AHEAD (2026-10-15: "only show positive entries"): a row whose net over the window is
  // 0 or below is not drawn - the viewer's own included. The seat ranks by net first, so the rows left keep ranks 1, 2, 3 ...
  const ahead = rows.filter((r) => r.sign > 0);
  const behind = rows.length - ahead.length;
  rows.length = 0; rows.push(...ahead);
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : SEASON_ROWS_SHOWN;
  const shown = rows.slice(0, cap);
  const own = rows.find((r) => r.mine) || null;
  // THE VIEWER'S OWN ROW BELOW THE TOP when it ranks further down: a player looks for himself first
  if (own && !shown.includes(own)) shown.push(own);
  const name = String(title || '').trim() || game || 'this game';
  const seats = answer.seats && typeof answer.seats === 'object' ? answer.seats : null;
  // FROM HOW MANY NODES: the seat that answered and every other seat whose account it merged (seats.answered), of itself
  // and every seat it asked (seats.asked) - a board from fewer nodes is a board fewer could confirm
  const nodes = answer.scope === 'network' && seats && Number.isSafeInteger(seats.asked) && Number.isSafeInteger(seats.answered)
    && seats.asked >= 0 && seats.answered >= 0
    ? { answered: Math.min(seats.answered, seats.asked) + 1, asked: seats.asked + 1 } : null;
  const last = days === 1 ? 'last day' : `last ${days} days`;
  const from = nodes ? `from ${nodes.answered} of ${nodes.asked} nodes` : 'from one node only';
  const header = [name, last, `${seasonCount(rows.length, 'player')} ahead`, from].join(' \u00b7 ');
  const counted = Number.isSafeInteger(answer.rounds) && answer.rounds >= 0 ? answer.rounds : null;
  const leftOut = Number.isSafeInteger(answer.leftOut) && answer.leftOut > 0 ? answer.leftOut : 0;
  const agree = Number.isSafeInteger(answer.agree) && answer.agree > 1 ? answer.agree : null;
  const foot = [counted === null ? null : `${seasonCount(counted, 'round')} counted`,
    leftOut ? `${leftOut} left out (not final yet${agree ? `, or fewer than ${agree} nodes agreed` : ''})` : null,
    agree ? `a round counts once ${agree} nodes hold the same account of it` : null].filter(Boolean).join(' \u00b7 ');
  // MORE: the players ranked below the rows drawn, the viewer's own row (drawn below them) not among them
  const more = rows.length - Math.min(rows.length, cap) - (own && rows.indexOf(own) >= cap ? 1 : 0);
  return { ok: true, title: name, game, days, header, foot, players: rows.length, behind, nodes, rows: shown, mine: own, more,
    empty: rows.length ? null : behind ? `Nobody is ahead at ${name} in the ${last}.` : `Nobody has a counted round of ${name} in the ${last}.` };
}

/**
 * ONE SEASON FROM THE FIRST SEAT THAT ANSWERS IT, in the order given: a seat that does not answer within `answerMs`, answers
 * anything but 200, sends no JSON or sends one seasonView refuses falls through to the next. Answers the view with the
 * seat it came from, or `{ ok: false, why, tried }` when none answered. `via` maps a seat's URL to the route the page
 * reaches it by (ARENA_ROUTED_URL).
 */
export async function fetchSeason({ nodes, game, days, title = null, viewer = [], fetch, via = (u) => u, answerMs = SEASON_ANSWER_MS, timeout } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    return { ok: false, why: 'a season is 1 to 90 whole days', tried: [] };
  if (!game) return { ok: false, why: 'a season is asked for by a game', tried: [] };
  const tried = [];
  for (const n of nodes || []) {
    const seat = String(n || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(seat)) continue;
    try {
      const signal = timeout ? timeout(answerMs) : undefined;
      const r = await fetch(via(seat + seasonPath(game, days)), { cache: 'no-store', signal });
      if (!r || !r.ok) { tried.push({ seat, why: `answered ${r ? r.status : 'nothing'}` }); continue; }
      const view = seasonView(await r.json(), { title, viewer });
      if (!view.ok) { tried.push({ seat, why: view.why }); continue; }
      return { ...view, seat };
    } catch (e) {
      tried.push({ seat, why: e && e.message ? e.message : String(e) });
    }
  }
  return { ok: false, why: tried.length ? 'no node answered the season just now' : 'no node to ask', tried };
}
