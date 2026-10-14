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
 */
function readRound(r) {
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
    entries.push({ player, stakeMsat: e.stakeMsat, payoutMsat: payout, score, outcome, name });
  }
  // THE ENTRIES IN ONE ORDER, so two copies of a round that differ only in the order they were listed are one round
  const key = (e) => [e.player, e.outcome ?? '', e.score ?? '', e.stakeMsat, e.payoutMsat ?? '', e.name ?? ''].join('|');
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
