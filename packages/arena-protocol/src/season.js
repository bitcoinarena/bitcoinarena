// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEASON: ONE GAME'S FINAL ROUNDS OVER A TIME WINDOW, PER PLAYER (kanban #362, feature 1 of docs/PLATFORM-RESEARCH.md).
//
// A round's board (leaderboard.js) is forgotten when the round ends; status over weeks is what brings a player back. So
// this adds the rounds of one game up - rounds played, wins, net msat, best score, last played - and it does so under the
// same law as the round's board: THE BOARD IS PRESENTATION, NOT AUTHORITY (0.11).
//
// IT COMPUTES NO PAYOUT. Every amount here is one the caller READ: what the round's signed settlement paid an entry (its
// payout table's row, a market's pari-mutuel row as the settlement paid it, the stake lock it did not claim), never one
// worked out again. There is no import of `computePayoutTable` or `pariMutuelTable` in this file, and there must not be:
// a season that re-derived amounts would be a second scoring path beside §20's, and the one that disagreed would be
// believed by whoever liked its numbers better. A round whose amounts are not signed yet is left out, not estimated.
//
// AND EVERY NODE HANDED THE SAME ROUNDS SHOWS THE SAME ROWS. The order is net msat, then wins, then best score, and
// the player key last - intrinsic, never chosen after the fact, and never arrival order: `Array.prototype.sort` is
// stable, which means it keeps the INPUT order on a tie, and the input order is exactly what must not decide a place.
// The rounds are read in round-id order for the same reason, so even the list of what was left out is the same list.
import { VOID, ENTRY_VOID, DELIVERED } from './payout.js';

export const DAY_MS = 86400000;
/** The window a season door shows when none is asked, and the longest it shows: a week, and a quarter. */
export const SEASON_DAYS_DEFAULT = 7;
export const SEASON_DAYS_MAX = 90;

/**
 * WHAT THIS FUNCTION CANNOT CHECK, named rather than left blank (leaderboard.js's discipline: a column nobody filled
 * looks the same as one somebody forgot). The caller is the node, which holds the curve and the store.
 */
export const SEASON_UNCHECKED = [
  'finality (no curve in this package: the caller hands in only entries whose result is FINAL - the committee\'s '
  + 'threshold of results and of FINAL signatures - and only amounts its round\'s settlement signed)',
  'who a round counts under (the caller maps each entry to a player key: an identity the player signed with that key, '
  + 'else the identity the round key\'s own signed lobby record names, else the round key - a lobby record\'s identity '
  + 'is the round key\'s claim, so a player can add its own results to an identity and can take none away)',
];

const HEX64 = /^[0-9a-f]{64}$/;
const REFUNDS = new Set([VOID, ENTRY_VOID]);

/**
 * THE WINDOW A DOOR ASKS FOR: `days` whole days back from `nowMs`, 1 to 90, the default a week. A day count that is not
 * a whole number in range is refused by name, not clamped: a board whose window was silently cut to 90 days would be
 * showing a quarter under a label that says a year.
 */
export function seasonWindow({ nowMs, days = SEASON_DAYS_DEFAULT } = {}) {
  const d = typeof days === 'string' ? (days.trim() === '' ? NaN : Number(days)) : days;
  if (!Number.isInteger(d) || d < 1 || d > SEASON_DAYS_MAX)
    return { ok: false, why: `a season is 1 to ${SEASON_DAYS_MAX} whole days` };
  if (!Number.isSafeInteger(Number(nowMs)) || Number(nowMs) < 0) return { ok: false, why: 'a season ends at a time in ms' };
  const to = Number(nowMs);
  return { ok: true, days: d, fromMs: to - d * DAY_MS, toMs: to };
}

const ms = (v) => {
  if (typeof v === 'bigint') return v;
  if (Number.isSafeInteger(v)) return BigInt(v);
  return null;
};

/**
 * One round as handed in, checked and normalised - or `{ why }`. Amounts are BigInt msat or nothing: a number would be a
 * float the first time a pool did not divide, and 'no amount' is NOT zero - zero is a loser's paid amount, null is a
 * settlement this node does not hold yet.
 *
 * WITH `keys`, EACH ENTRY'S ROUND KEY IS PART OF THE ACCOUNT: kept on the entry and in the bytes compared. The weekly board
 * badge (badges.js) awards an identity only, never a bare round key, so a board it reads from other seats must agree on
 * which key each entry joined under as well as on its amounts - a round key taken from whichever seat answered first would
 * let that one seat hand a podium place to a round key or take one from an identity. Without `keys` (season(), the network
 * board) the round key is not read at all: the board shows no such thing, and seats that do not send it still agree.
 */
function readRound(r, { keys = false } = {}) {
  if (!r || typeof r !== 'object') return { why: 'that is not a round' };
  const id = String(r.roundId || '').toLowerCase();
  if (!HEX64.test(id)) return { why: 'a round is named by its 32-byte id in hex' };
  const game = String(r.gameId || '').toLowerCase();
  if (!HEX64.test(game)) return { id, why: 'that round names no game id' };
  const startMs = ms(r.startMs);
  if (startMs === null || startMs < 0n) return { id, why: 'that round names no start time in ms' };
  if (!Array.isArray(r.entries)) return { id, why: 'that round lists no entries' };
  const entries = [];
  for (const e of r.entries) {
    const player = String((e && e.player) || '').toLowerCase();
    if (!HEX64.test(player)) return { id, why: 'an entry names no 32-byte player key in hex' };
    if (typeof e.stakeMsat !== 'bigint' || e.stakeMsat < 0n) return { id, why: 'an entry\'s stake is BigInt msat, 0 or more' };
    const payout = e.payoutMsat === null || e.payoutMsat === undefined ? null : e.payoutMsat;
    if (payout !== null && (typeof payout !== 'bigint' || payout < 0n))
      return { id, why: 'an entry\'s payout is BigInt msat, 0 or more, or null while its settlement is not held' };
    const score = e.score === null || e.score === undefined ? null : e.score;
    if (score !== null && !Number.isSafeInteger(score)) return { id, why: 'an entry\'s score is an integer, or null for a market pick' };
    const outcome = e.outcome === null || e.outcome === undefined ? null : String(e.outcome);
    const name = typeof e.name === 'string' && e.name !== '' ? e.name : null;
    if (!keys) { entries.push({ player, stakeMsat: e.stakeMsat, payoutMsat: payout, score, outcome, name }); continue; }
    const roundKey = e.roundKey === null || e.roundKey === undefined ? null : String(e.roundKey).toLowerCase();
    if (roundKey !== null && !HEX64.test(roundKey)) return { id, why: 'an entry\'s round key is a 32-byte key in hex, or null' };
    entries.push({ player, stakeMsat: e.stakeMsat, payoutMsat: payout, score, outcome, name, roundKey });
  }
  // THE ENTRIES IN ONE ORDER, so two copies of a round that differ only in the order they were listed are one round
  const key = (e) => [e.player, e.outcome ?? '', e.score ?? '', e.stakeMsat, e.payoutMsat ?? '', e.name ?? '',
    ...(keys ? [e.roundKey ?? ''] : [])].join('|');
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const canon = JSON.stringify([id, game, String(startMs), !!r.void, entries.map(key)]);
  return { id, game, startMs, void: !!r.void, entries, canon };
}

/**
 * THE SEASON, from rounds of one game the caller has read out of its store.
 *
 * `rounds`: `{ roundId, gameId, startMs, void, entries: [{ player, stakeMsat, payoutMsat, outcome, score, name }] }` -
 * `player` the key the season counts the entry under (SEASON_UNCHECKED says who chooses it), `payoutMsat` what the
 * round's settlement paid that entry back in all (null while it is not held), `outcome`/`score` the FINAL result's
 * (null for a market pick, which has no score). `games`: the game ids (hex) this season is of - a game's versions are
 * several ids. `fromMs` <= a round's start < `toMs`.
 *
 * Rows: `{ rank, player, name, rounds, wins, netMsat, stakedMsat, paidMsat, bestScore, lastPlayedMs }`.
 */
export function season(rounds, { games, fromMs, toMs } = {}) {
  if (!Array.isArray(rounds)) return { ok: false, why: 'no rounds to build a season from' };
  const gameSet = new Set([...(games instanceof Set ? games : Array.isArray(games) ? games : [])].map((g) => String(g).toLowerCase()));
  if (!gameSet.size || [...gameSet].some((g) => !HEX64.test(g))) return { ok: false, why: 'a season is of a game, named by its id in hex' };
  const from = ms(fromMs), to = ms(toMs);
  if (from === null || to === null || from >= to) return { ok: false, why: 'a season\'s window is a start before its end, in ms' };

  const excluded = [];
  // ONE ROUND PER ID. The same round handed in twice is a repeat and counts once; two DIFFERENT accounts of one round are
  // a contradiction the season is not the place to settle, so it counts neither - picking one would let whoever handed
  // in the second copy, or whichever arrived first, decide a player's row.
  const byId = new Map();
  for (const raw of rounds) {
    const r = readRound(raw);
    if (r.why) { excluded.push({ round: r.id || null, why: r.why }); continue; }
    const had = byId.get(r.id);
    if (!had) { byId.set(r.id, r); continue; }
    if (had.canon === r.canon) excluded.push({ round: r.id, why: 'that round was handed in more than once: counted once' });
    else had.conflict = true;
  }

  const players = new Map();
  let counted = 0;
  for (const r of [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (r.conflict) { excluded.push({ round: r.id, why: 'two different accounts of that round were handed in, and the season does not choose between them' }); continue; }
    if (!gameSet.has(r.game)) { excluded.push({ round: r.id, why: 'that round is of another game' }); continue; }
    if (r.startMs < from || r.startMs >= to) { excluded.push({ round: r.id, why: 'that round started outside the season\'s window' }); continue; }
    // A VOID ROUND IS NO ROUND PLAYED: every stake came back, nobody placed (§18: VOID neither contributes to nor draws
    // from the pool). Counting it would hand every player in it a "round played" and a net of 0 for a game that did not
    // happen - and it would dilute a win rate with rounds the infrastructure lost.
    if (r.void) { excluded.push({ round: r.id, why: 'a VOID round refunds every stake: it is no round played' }); continue; }

    // THE ENTRIES THAT COUNT: a refunded one (VOID, ENTRY_VOID) is not a place, as on the round's board, and one with no
    // signed amount is not settled here yet - left out, never guessed at.
    const per = new Map();
    for (const e of r.entries) {
      if (e.outcome !== null && REFUNDS.has(e.outcome)) {
        excluded.push({ round: r.id, player: e.player, why: `a ${e.outcome} entry is refunded: it is no round played` });
        continue;
      }
      if (e.payoutMsat === null) {
        excluded.push({ round: r.id, player: e.player, why: 'no settlement of that entry is held: its amount is not signed yet' });
        continue;
      }
      // ONE PLAYER, ONE ROUND: a player may hold several entries in a round (every PLAY is an entry), and the round is
      // still one round played - its stakes and payouts are added, its best score kept.
      const p = per.get(e.player) || { stakeMsat: 0n, payoutMsat: 0n, bestScore: null, delivered: null, names: [] };
      p.stakeMsat += e.stakeMsat;
      p.payoutMsat += e.payoutMsat;
      if (e.score !== null && (p.bestScore === null || e.score > p.bestScore)) p.bestScore = e.score;
      if (e.outcome === DELIVERED && e.score !== null && (p.delivered === null || e.score > p.delivered)) p.delivered = e.score;
      if (e.name !== null) p.names.push(e.name);
      per.set(e.player, p);
    }
    if (!per.size) { excluded.push({ round: r.id, why: 'no entry of that round is settled and unrefunded' }); continue; }
    counted++;

    // RANK 1 IS THE ROUND'S SOLE HIGHEST DELIVERED SCORE. A shared top score is not a win by rank - the round's board
    // breaks that tie by the player key, which is a presentation order, not a victory - and a run that did not deliver
    // is ranked by the board but did not finish the game. (A head-to-head draw is two DELIVERED at one score: no win.)
    let top = null, holders = 0;
    for (const p of per.values()) {
      if (p.delivered === null) continue;
      if (top === null || p.delivered > top) { top = p.delivered; holders = 1; } else if (p.delivered === top) holders++;
    }

    for (const [player, p] of per) {
      const row = players.get(player) || { player, rounds: 0, wins: 0, netMsat: 0n, stakedMsat: 0n, paidMsat: 0n,
        bestScore: null, lastPlayedMs: -1n, name: null, nameAt: null };
      row.rounds++;
      // A WIN: rank 1, or the settlement paid the player more than it staked - a market's right pick, a qualifier's share
      if ((holders === 1 && p.delivered === top) || p.payoutMsat > p.stakeMsat) row.wins++;
      row.stakedMsat += p.stakeMsat;
      row.paidMsat += p.payoutMsat;
      row.netMsat += p.payoutMsat - p.stakeMsat;
      if (p.bestScore !== null && (row.bestScore === null || p.bestScore > row.bestScore)) row.bestScore = p.bestScore;
      if (r.startMs > row.lastPlayedMs) row.lastPlayedMs = r.startMs;
      // THE NAME OF THE PLAYER'S LATEST ROUND (by start, then round id): a player who renamed shows the new name, and
      // two names in one round resolve to the first in code-point order - never to whichever came first
      if (p.names.length) {
        const at = `${String(r.startMs).padStart(20, '0')}:${r.id}`;
        if (row.nameAt === null || at > row.nameAt) { row.name = [...p.names].sort()[0]; row.nameAt = at; }
      }
      players.set(player, row);
    }
  }

  const rows = [...players.values()].sort((a, b) => {
    if (a.netMsat !== b.netMsat) return a.netMsat > b.netMsat ? -1 : 1;
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.bestScore !== b.bestScore) {
      if (a.bestScore === null) return 1;
      if (b.bestScore === null) return -1;
      return b.bestScore - a.bestScore;
    }
    return a.player < b.player ? -1 : a.player > b.player ? 1 : 0;
  }).map((x, i) => ({ rank: i + 1, player: x.player, name: x.name, rounds: x.rounds, wins: x.wins, netMsat: x.netMsat,
    stakedMsat: x.stakedMsat, paidMsat: x.paidMsat, bestScore: x.bestScore, lastPlayedMs: Number(x.lastPlayedMs) }));

  // WHAT WAS LEFT OUT, in one order too: rounds handed in malformed or twice were met in the caller's order
  const ek = (x) => `${x.round || ''}|${x.player || ''}|${x.why}`;
  excluded.sort((a, b) => (ek(a) < ek(b) ? -1 : ek(a) > ek(b) ? 1 : 0));
  return { ok: true, fromMs: Number(from), toMs: Number(to), rows, rounds: counted, excluded, unchecked: SEASON_UNCHECKED };
}

// A NETWORK-WIDE SEASON (kanban #362 feature 1, scope=network). A round is held only by the seats of its committee - 7 of
// the 14 testnet4 seats - so one seat's own season misses about half the rounds. The network season asks every seat it
// knows for its rounds of that season (GET /season-rounds) and adds them up. That makes it a board built partly from
// OTHER seats' word, which this seat did not verify: it holds neither their results nor their settlements. So a round
// from the network counts on agreement alone, and on enough of it that no single seat - nor two - can forge a row.

/**
 * HOW MANY DISTINCT SEATS MUST HAND IN BYTE-IDENTICAL ACCOUNTS OF A ROUND before a network season counts it: 3.
 *
 * WHY 3. An honest round is FINAL only once its committee's threshold of seats (5 of 7) signed the same run and held each
 * other's FINAL signatures, and its settlement is ACCEPTED only once that many signed it - so a real round, settled, sits
 * in at least 5 seats' stores with the same results and the same amounts, and 3 identical accounts of it are always
 * reachable even with two of those seats down or lagging. A FORGED round - one no committee ran, or a real one with a row
 * made up - is in no honest seat's store: to put it on the board takes 3 seats colluding, each handing in the same lie.
 * One seat cannot, and two cannot; and the board stays presentation, not authority, whatever it shows.
 */
export const SEASON_NETWORK_AGREE = 3;

/** WHAT A NETWORK SEASON CANNOT CHECK, beside SEASON_UNCHECKED: the other seats' stores. */
export const SEASON_NETWORK_UNCHECKED = [
  `the other seats' accounts (this seat holds neither their FINAL results nor their settlements: a round from the network `
  + `counts when ${SEASON_NETWORK_AGREE} seats hand in byte-identical accounts of it - SEASON_NETWORK_AGREE - and only then)`,
];

/** One round as season() reads it, in its one order (readRound's): what an agreed account hands on to season(). */
const normalised = (r) => ({ roundId: r.id, gameId: r.game, startMs: r.startMs, void: r.void,
  entries: r.entries.map((e) => ({ ...e })) });

/**
 * THE ROUNDS SEVERAL SEATS HANDED IN, MERGED BY AGREEMENT. `accountsBySeat`: a Map (or a plain object) of a seat's label -
 * one label per seat, never two for one seat: the caller's to see to - to the rounds that seat handed in, in season()'s
 * shape. `agree`: the seats needed (SEASON_NETWORK_AGREE). `keys`: each entry's round key is part of the account (readRound),
 * and handed on with the agreed round - what the weekly board badge merges with; the network board merges without.
 *
 * Each seat's account of a round is read as season() reads it (readRound: the entries in one order, its `canon` the bytes
 * compared), and per round:
 *   - A SEAT COUNTS ONCE. The same account handed in twice by one seat is one seat's word, not two; a seat that handed in
 *     two DIFFERENT accounts of one round contradicts itself, and backs neither.
 *   - THE ACCOUNT HELD BY THE MOST SEATS COUNTS, when it is held by `agree` or more and no other account by as many. A
 *     seat that disagrees with it does not take the round off the board: a seat whose settlement is not ACCEPTED yet hands
 *     in the same round with no amounts - an honest, passing disagreement - and if one dissenting seat could strike a
 *     round, any one seat could empty the board of every round it holds. It would take as many seats as back the round,
 *     at `agree` at least, to dispute it.
 *   - TWO ACCOUNTS HELD BY EQUALLY MANY SEATS, the most: the seats disagree on that round, and it is left out - the
 *     season does not choose between them, as season() does not between two accounts handed to it.
 *   - NO ACCOUNT HELD BY `agree` SEATS: left out, named "held by fewer than" when they all said the same, "the seats
 *     disagree" when they did not.
 *
 * Returns `{ ok, agree, rounds, excluded }`: `rounds` the agreed accounts, in round-id order, each normalised (its
 * entries in one order) so that the input's order decides nothing; `excluded` `{ round, seat?, why }`, in one order too.
 * season() then runs on `rounds`.
 */
export function mergeSeasonAccounts(accountsBySeat, { agree = SEASON_NETWORK_AGREE, keys = false } = {}) {
  if (!Number.isSafeInteger(agree) || agree < 1) return { ok: false, why: 'agreement takes a whole number of seats, 1 or more' };
  const pairs = accountsBySeat instanceof Map ? [...accountsBySeat] : accountsBySeat && typeof accountsBySeat === 'object'
    ? Object.entries(accountsBySeat) : null;
  if (!pairs) return { ok: false, why: 'no seats\' rounds to merge' };
  const excluded = [];
  // round id -> seat -> { canons: Set, first: the read round of each canon }
  const held = new Map();
  const reads = new Map();                       // canon -> the read round
  for (const [label, rounds] of pairs) {
    const seat = String(label);
    for (const raw of Array.isArray(rounds) ? rounds : []) {
      const r = readRound(raw, { keys });
      if (r.why) { excluded.push({ round: r.id || null, seat, why: r.why }); continue; }
      const per = held.get(r.id) || new Map();
      const had = per.get(seat) || new Set();
      had.add(r.canon);
      per.set(seat, had);
      held.set(r.id, per);
      if (!reads.has(r.canon)) reads.set(r.canon, r);
    }
  }

  const agreed = [];
  for (const id of [...held.keys()].sort()) {
    const tally = new Map();                     // canon -> seats backing it
    for (const [seat, canons] of held.get(id)) {
      if (canons.size > 1) { excluded.push({ round: id, seat, why: 'that seat handed in two different accounts of that round: it backs neither' }); continue; }
      const [c] = canons;
      tally.set(c, (tally.get(c) || 0) + 1);
    }
    const counts = [...tally.values()].sort((a, b) => b - a);
    const most = counts[0] || 0;
    if (most >= agree && counts[1] !== most) {
      const [canon] = [...tally].find(([, n]) => n === most);
      agreed.push(normalised(reads.get(canon)));
    } else if (most >= agree) {
      excluded.push({ round: id, why: `the seats disagree on that round: two accounts of it are each held by ${most} seats` });
    } else if (tally.size > 1) {
      excluded.push({ round: id, why: `the seats disagree on that round, and no account of it is held by ${agree} seats` });
    } else {
      excluded.push({ round: id, why: `that round is held by fewer than ${agree} seats with one account of it` });
    }
  }
  const ek = (x) => `${x.round || ''}|${x.seat || ''}|${x.why}`;
  excluded.sort((a, b) => (ek(a) < ek(b) ? -1 : ek(a) > ek(b) ? 1 : 0));
  return { ok: true, agree, rounds: agreed, excluded };
}

/**
 * A SEASON'S ROUNDS ON THE WIRE (GET /season-rounds): every msat and the start time as a decimal string - JSON has no
 * BigInt, and a number would be a float past 2^53 - and back. A value that is not a decimal string is handed on as it
 * came, for readRound to refuse by name: nothing is mended on the way in. Each entry's `roundKey` (the key it joined under,
 * hex) travels too, null where the caller has none: the board badge merges on it (mergeSeasonAccounts `keys`), and a reader
 * that does not know the field ignores it.
 */
export function seasonRoundsToJson(rounds) {
  const s = (v) => (v === null || v === undefined ? null : String(v));
  return (rounds || []).map((r) => ({ roundId: r.roundId, gameId: r.gameId, startMs: s(r.startMs), void: !!r.void,
    entries: (r.entries || []).map((e) => ({ player: e.player, name: e.name ?? null, stakeMsat: s(e.stakeMsat),
      payoutMsat: s(e.payoutMsat), outcome: e.outcome ?? null, score: e.score ?? null, roundKey: e.roundKey ?? null })) }));
}

export function seasonRoundsFromJson(list) {
  const big = (v) => (typeof v === 'string' && /^[0-9]{1,30}$/.test(v) ? BigInt(v) : v);
  if (!Array.isArray(list)) return [];
  return list.map((r) => (!r || typeof r !== 'object' ? r : { roundId: r.roundId, gameId: r.gameId, startMs: big(r.startMs), void: r.void === true,
    entries: Array.isArray(r.entries) ? r.entries.map((e) => (!e || typeof e !== 'object' ? e : { player: e.player, name: e.name ?? null,
      stakeMsat: big(e.stakeMsat), payoutMsat: big(e.payoutMsat), outcome: e.outcome ?? null, score: e.score ?? null,
      roundKey: e.roundKey ?? null })) : r.entries }));
}
