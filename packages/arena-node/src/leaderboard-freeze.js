// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEADERBOARD PAYOUT'S WINNERS, FROZEN (kanban #1153, critical). The payout pays the top N of a season from the federation's
// reserves (§27A.9, reserve-payout.js). Until this, every guardian seat read the season again whenever it was asked to sign - a
// round counted when three seats handed in byte-identical UNSIGNED accounts - so three colluding bonded seats could invent rounds
// and enter the top N, and two co-signers asking at different moments could read two different lists.
//
// THE STATE, one enum and one transition function (winnersStep), each step written compare-and-set:
//
//   OPEN     no winners here yet (no row). The window must have closed FREEZE_GRACE_MS ago, so every round of it is settled at
//            its seats; until then nothing is read.
//   FROZEN   this seat's own read, once: every seat's signed accounts of the window (GET /season-rounds), merged by protocol
//            mergeSignedSeasonAccounts - a round counts only with its contract checked by id and its account signed by the
//            threshold of the round's own draw, as this seat draws it - and the winners of exactly those rounds. Written once and
//            never read again; while a round's draw cannot be computed here yet, the freeze waits (FREEZE_PENDING_MAX_MS at most).
//   PLANNED  the list this seat signs for: the plan's winners, the (round, account) pairs they were taken from, and the evidence of
//            each pair, persisted BEFORE this seat commits to the payout's transaction - so nothing it signs rests on a list it does
//            not hold. A plan stands here only when every round of this seat's FROZEN read is in it (none left out), every round of
//            it stands on evidence this seat checked itself, and its winners are exactly what those rounds give. One list per payout:
//            another is refused.
//
// THE SAME LIST AT EVERY CO-SIGNER: the coordinator plans over the union of its own frozen evidence and every guardian peer's
// (GET /leaderboard-winners), so its plan holds every round any of them counts; a co-signer takes from it only rounds it verifies.
import { mergeSignedSeasonAccounts, evidenceAnswers } from '../../arena-protocol/src/season.js';
import { leaderboardWinners } from '../../arena-protocol/src/leaderboard-winners.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { utf8Encode } from '../../arena-protocol/src/utf8.js';

export const WINNERS = Object.freeze({ OPEN: 'OPEN', FROZEN: 'FROZEN', PLANNED: 'PLANNED' });
export const WINNERS_EVENT = Object.freeze({ FREEZE: 'freeze', PLAN: 'plan' });
/** How long after the window closes the season is read: its last rounds settled at every seat (as the weekly board badge waits). */
export const FREEZE_GRACE_MS = 2 * 3600000 + 15 * 60000;
/** How long a freeze waits for rounds whose draw this seat cannot compute yet, before it freezes without them. */
export const FREEZE_PENDING_MAX_MS = 6 * 3600000;
export const WINNERS_SQL = `CREATE TABLE IF NOT EXISTS leaderboard_winners (proposal TEXT PRIMARY KEY, state TEXT NOT NULL, own TEXT NOT NULL,
  bound TEXT, winners_id TEXT, frozen_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`;

/**
 * THE ONE TRANSITION FUNCTION: from a state and an event, the next state or why not. `same`: a PLAN event names the list already
 * bound here (asked again - the same answer).
 */
export function winnersStep(from, event, { same = false } = {}) {
  if (!Object.values(WINNERS).includes(from)) return { ok: false, why: `no winners state ${from}` };
  if (event === WINNERS_EVENT.FREEZE) {
    if (from === WINNERS.OPEN) return { ok: true, to: WINNERS.FROZEN };
    return { ok: false, why: `the winners are ${from} here: read once, never again` };
  }
  if (event === WINNERS_EVENT.PLAN) {
    if (from === WINNERS.OPEN) return { ok: false, why: 'this seat has not read the season yet: no plan\'s winners are taken before its own' };
    if (from === WINNERS.FROZEN) return { ok: true, to: WINNERS.PLANNED };
    if (same) return { ok: true, to: WINNERS.PLANNED };
    return { ok: false, why: 'another list of winners is planned for that payout here: one list per payout' };
  }
  return { ok: false, why: `no winners event ${event}` };
}

const norm = (ws) => (ws || []).map((w) => ({ player: String(w.player).toLowerCase(), payoutPk: String(w.payoutPk).toLowerCase(), msat: String(w.msat),
  ...(w.places !== undefined ? { places: String(w.places) } : {}) }));
/** A list's id: the payout, its winners in order (who, to which key, how much) and the (round, account) pairs they come from. */
export const winnersIdOf = (proposal, winners, pairs) => toHex(taggedHash('ARENA/v1/LeaderboardWinners',
  utf8Encode(JSON.stringify([String(proposal), norm(winners).map((w) => [w.player, w.payoutPk, w.msat]), (pairs || []).map(([r, a]) => [String(r), String(a)])]))));
const pairKey = ([r, a]) => `${r}:${a}`;

/**
 * `db`; `paramsOf(id)` async -> { ok, games, fromMs, toMs, top, amountMsat, splitBps } the payout's season or why not;
 * `collect(id, params)` async -> every seat's signed answers (a Map label -> rounds, this seat's own included); `seatsOf` and `verify`
 * as mergeSignedSeasonAccounts takes them.
 */
export function createWinnersBook({ db, paramsOf, collect, seatsOf, verify, now = () => Date.now(), graceMs = FREEZE_GRACE_MS,
  pendingMaxMs = FREEZE_PENDING_MAX_MS, log = () => {} }) {
  db.exec(WINNERS_SQL);
  const rowOf = (id) => {
    const r = db.prepare('SELECT * FROM leaderboard_winners WHERE proposal = ?').get(String(id));
    return r ? { proposal: r.proposal, state: r.state, own: JSON.parse(r.own), bound: r.bound ? JSON.parse(r.bound) : null, winnersId: r.winners_id, frozenMs: Number(r.frozen_ms) } : null;
  };
  const stateOf = (id) => { const r = rowOf(id); return r ? r.state : WINNERS.OPEN; };
  const merged = (answers) => mergeSignedSeasonAccounts(answers, { seatsOf, verify });
  const winnersFrom = (p, rounds) => {
    const w = leaderboardWinners({ rounds, games: p.games, fromMs: p.fromMs, toMs: p.toMs, top: p.top, amountMsat: BigInt(p.amountMsat), splitBps: p.splitBps || [] });
    return w.ok ? { ok: true, winners: norm(w.winners) } : w;
  };
  const reading = new Map();

  /** OPEN -> FROZEN: this seat's own read, once. Answers { ok, record } or { ok: false, why, wait }. */
  async function freeze(id) {
    const had = rowOf(id);
    if (had) return { ok: true, record: had };
    if (reading.has(id)) return reading.get(id);
    const go = (async () => {
      const p = await paramsOf(id);
      if (!p || !p.ok) return { ok: false, why: p ? p.why : 'no such payout', wait: true };
      if (now() < Number(p.toMs) + graceMs) return { ok: false, why: `the season closes ${new Date(Number(p.toMs)).toISOString()} and is read ${graceMs / 60000} min after`, wait: true };
      let answers; try { answers = await collect(id, p); } catch (e) { return { ok: false, why: `the seats could not be asked: ${e.message}`, wait: true }; }
      const m = merged(answers);
      if (!m.ok) return { ok: false, why: m.why, wait: true };
      if (m.pending.length && now() < Number(p.toMs) + graceMs + pendingMaxMs)
        return { ok: false, why: `${m.pending.length} round(s) whose seats this seat cannot draw yet`, wait: true };
      const w = winnersFrom(p, m.rounds);
      if (!w.ok) return { ok: false, why: w.why, wait: true };
      const step = winnersStep(stateOf(id), WINNERS_EVENT.FREEZE);
      if (!step.ok) return { ok: true, record: rowOf(id) };
      const own = { winners: w.winners, pairs: m.pairs, evidence: m.evidence, counted: m.rounds.length, leftOut: m.excluded.length, pending: m.pending };
      const t = now();
      // COMPARE-AND-SET: only over no row; a freeze that lost the race keeps the one written
      db.prepare('INSERT OR IGNORE INTO leaderboard_winners (proposal, state, own, bound, winners_id, frozen_ms, updated_ms) VALUES (?, ?, ?, NULL, ?, ?, ?)')
        .run(String(id), step.to, JSON.stringify(own), winnersIdOf(id, w.winners, m.pairs), t, t);
      log(`[leaderboard] ${String(id).slice(0, 16)}: winners FROZEN - ${w.winners.length} winner(s) from ${m.rounds.length} signed round(s), ${m.excluded.length} left out`);
      return { ok: true, record: rowOf(id) };
    })().finally(() => reading.delete(id));
    reading.set(id, go);
    return go;
  }

  /** The evidence this seat hands a peer: the list it planned for, else its frozen read. */
  function recordOf(id) {
    const r = rowOf(id);
    if (!r) return { ok: true, proposal: String(id), state: WINNERS.OPEN };
    const x = r.state === WINNERS.PLANNED ? r.bound : r.own;
    return { ok: true, proposal: r.proposal, state: r.state, winnersId: r.state === WINNERS.PLANNED ? r.bound.winnersId : r.winnersId,
      winners: x.winners, pairs: x.pairs, evidence: x.evidence };
  }

  /** THE COORDINATOR'S LIST: its frozen evidence and the peers' (each checked here), merged; the bound list once one is planned. */
  async function union(id, others = []) {
    const f = await freeze(id);
    if (!f.ok) return f;
    const r = f.record;
    if (r.state === WINNERS.PLANNED) return { ok: true, ...r.bound };
    const p = await paramsOf(id);
    if (!p || !p.ok) return { ok: false, why: p ? p.why : 'no such payout' };
    const m = merged([...evidenceAnswers(r.own.evidence), ...others.flatMap((e) => evidenceAnswers(e))]);
    if (!m.ok) return m;
    const w = winnersFrom(p, m.rounds);
    if (!w.ok) return w;
    return { ok: true, winners: w.winners, pairs: m.pairs, evidence: m.evidence, winnersId: winnersIdOf(id, w.winners, m.pairs) };
  }

  /**
   * DOES A PLAN'S LIST STAND HERE: this seat's own read frozen first; none of its rounds left out of the plan; every round of the plan
   * checked here on evidence (its own, `evidence` handed in, else what `fetch()` gets from the peers); the winners exactly those rounds'.
   * Answers { ok, bind } (what plan() persists) or { ok: false, why, status }.
   */
  async function check(id, plan, { evidence = [], fetch = async () => [] } = {}) {
    const f = await freeze(id);
    if (!f.ok) return { ok: false, status: 503, why: `this seat has not read the season's winners yet: ${f.why}` };
    const r = f.record;
    const winnersId = winnersIdOf(id, plan.winners, plan.rounds);
    if (plan.winnersId !== winnersId) return { ok: false, status: 422, why: 'the plan\'s winners id is not its winners\' and rounds\'' };
    if (r.state === WINNERS.PLANNED) return r.bound.winnersId === winnersId ? { ok: true, bind: r.bound }
      : { ok: false, status: 409, why: 'another list of winners is planned for that payout here: one list per payout' };
    const want = new Set((plan.rounds || []).map(pairKey));
    const left = (r.own.pairs || []).filter((x) => !want.has(pairKey(x)));
    if (left.length) return { ok: false, status: 422, why: `the plan leaves out round ${String(left[0][0]).slice(0, 16)}, which this seat counts (${left.length} in all)` };
    let pool = [...(r.own.evidence || []), ...(evidence || [])];
    const have = () => new Set(pool.map((e) => `${e.roundId}:${e.accountId}`));
    if ([...want].some((k) => !have().has(k))) { let more = []; try { more = await fetch(); } catch { more = []; } for (const e of more || []) pool = pool.concat(Array.isArray(e) ? e : []); }
    const m = merged(evidenceAnswers(pool.filter((e) => e && want.has(`${e.roundId}:${e.accountId}`))));
    if (!m.ok) return { ok: false, status: 422, why: m.why };
    const got = new Set(m.pairs.map(pairKey));
    const unproven = [...want].filter((k) => !got.has(k));
    if (unproven.length) return { ok: false, status: 422, why: `round ${unproven[0].slice(0, 16)} of the plan does not stand on evidence this seat checked (${unproven.length} in all)` };
    if (JSON.stringify(m.pairs) !== JSON.stringify((plan.rounds || []).map(([x, a]) => [String(x), String(a)]))) return { ok: false, status: 422, why: 'the plan lists its rounds out of their one order' };
    const p = await paramsOf(id);
    if (!p || !p.ok) return { ok: false, status: 503, why: p ? p.why : 'no such payout' };
    const w = winnersFrom(p, m.rounds);
    if (!w.ok) return { ok: false, status: 422, why: w.why };
    const same = w.winners.length === plan.winners.length && w.winners.every((x, i) => { const y = norm([plan.winners[i]])[0]; return x.player === y.player && x.payoutPk === y.payoutPk && x.msat === y.msat; });
    if (!same) return { ok: false, status: 422, why: 'the plan pays other winners or other amounts than those rounds give' };
    return { ok: true, bind: { winnersId, winners: w.winners, pairs: m.pairs, evidence: m.evidence } };
  }

  /** FROZEN -> PLANNED: the list this seat signs for, persisted before it commits. Compare-and-set over FROZEN; the same list again is a no-op. */
  function plan(id, bind) {
    const r = rowOf(id);
    const step = winnersStep(r ? r.state : WINNERS.OPEN, WINNERS_EVENT.PLAN, { same: !!(r && r.bound && r.bound.winnersId === bind.winnersId) });
    if (!step.ok) return { ok: false, status: 409, why: step.why };
    if (r.state === WINNERS.PLANNED) return { ok: true, state: WINNERS.PLANNED };
    const ch = db.prepare('UPDATE leaderboard_winners SET state = ?, bound = ?, updated_ms = ? WHERE proposal = ? AND state = ?')
      .run(step.to, JSON.stringify(bind), now(), String(id), WINNERS.FROZEN);
    if (Number(ch.changes) !== 1) return plan(id, bind);            // the row moved under us: decided again on what it holds now
    log(`[leaderboard] ${String(id).slice(0, 16)}: winners PLANNED - ${bind.winners.length} winner(s), list ${String(bind.winnersId).slice(0, 16)}`);
    return { ok: true, state: WINNERS.PLANNED };
  }

  return { freeze, union, check, plan, recordOf, stateOf };
}
