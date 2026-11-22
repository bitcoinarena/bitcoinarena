// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORANGE PILL RUN ROUND SERVICE (kanban #3245; #3248 rounds, entry, attempts, board, pot; #3249 server-checked scores, bot signals, replays;
// #3250 X placement, bounty, payout lists with sign-off; #3256 rounds posted on chain, test rounds). One process, one node:sqlite file.
// Everything it needs from outside is handed in, so tests run it with fakes:
//   sim { buildLevel(candles, seed, version), runLog(L, log, { maxSteps }), GAME_VERSION }   (src/sim, the same code the page runs)
//   fetchCandles(day) -> 48 candles of that UTC day                                  (src/candles.mjs)
//   checkLevel(candles, roundId, { version }) -> { ok, seed, tries, hash }                  (src/level-check.mjs)
//   invoices { create, lookup }                                                      (opr-invoices.mjs: one testnet4 lnd)
//   chain { post(payloadHex) -> txid, status(txid) -> { confirmations, height } }    (opr-chain.mjs; null: no post, a round opens on its level)
//   s2: the bug bounty's Season 2 store (arena-node/src/bounty-season.js openBountySeason) - its X links decide who is placed; read only here
//   alert(text): the owner's alert hook (off unless configured)
// NOTHING IS PAID HERE. The service writes payout lists and their approval records; paying stays a separate step.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { eventRefusal } from '../../arena-node/src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../../arena-node/src/feedback-store.js';
import { encodeRoundPost, levelHashOf } from './opr-chain.mjs';
import { bestPerPlayer, payoutLists, SPLIT } from './opr-payout.mjs';

const DAY_MS = 86400000, MIN_MS = 60000;
export const DEFAULTS = Object.freeze({
  firstDay: '2026-11-23', daily: true, entrySats: 100, maxAttempts: 5, submitMs: 10 * MIN_MS, lastCallMs: 5 * MIN_MS, invoiceS: 600,
  verifyGraceMs: 60 * MIN_MS, bountySats: 2000, bountyClaimMs: 7 * DAY_MS, alertAfterMs: 15 * MIN_MS, fastSlackMs: 1000, maxSteps: 180 * 60,
  confirmations: 1, publicBases: ['https://testnet-stage.bitcoinarena.io/api/opr'], adminSha: '', workerKey: '', showTest: false, ipCrowd: 3,
  testMinutesMost: 24 * 60, logPressesMost: 6000, bodyMost: 256 * 1024,
});
export const AUTH_AGE_MOST_S = 60;
export const TEST_ATTEMPTS_MOST = 99;   // a test round's attempts per player at most (kanban #3256); the daily rounds keep cfg.maxAttempts (5)
const ADMIN_TRY_WINDOW_MS = 15 * MIN_MS, ADMIN_TRIES_PER_CALLER = 5, ADMIN_TRIES_ALL = 30;   // as the faucet's admin (kanban #3243)
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00Z`);
const sha = (x) => createHash('sha256').update(x).digest('hex');
const J = (x, d = null) => { try { return x == null ? d : JSON.parse(x); } catch { return d; } };

/** A well-formed input log: { v, presses: [[down, up], ...] }, sorted, non-overlapping whole steps, nothing else. */
export function logRefusal(log, { maxSteps, most = 6000 } = {}) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return 'the log is not an object';
  const keys = Object.keys(log).sort().join(',');
  if (keys !== 'presses,v') return 'the log has other fields than v and presses';
  if (typeof log.v !== 'string' || !log.v || log.v.length > 32) return 'the log names no game version';
  if (!Array.isArray(log.presses) || log.presses.length > most) return 'the presses are not a list';
  let last = -1;
  for (const p of log.presses) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger)) return 'a press is not two whole step numbers';
    const [d, u] = p;
    if (d < 0 || u <= d || d <= last || u > maxSteps) return 'the presses are not sorted, not separate or out of the run';
    last = u;
  }
  return null;
}

/** Bot signals of one run, read from its own log (kanban #3249): too regular, frame-perfect holds; the hidden tab as the page reports it. */
export function runSignals(log, client = {}) {
  const f = {};
  const ps = log.presses;
  if (ps.length >= 12) {
    const gaps = ps.slice(1).map((p, i) => p[0] - ps[i][0]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (mean > 0 && sd / mean < 0.03) f.regular = true;
    if (new Set(ps.map(([d, u]) => u - d)).size === 1) f.sameHold = true;
  }
  if (client && (client.visible === false || Number(client.hiddenMs) > 0)) f.hidden = true;
  return f;
}

export function createOpr(o = {}) {
  const cfg = { ...DEFAULTS, ...(o.cfg || {}) };
  const now = o.now || (() => Date.now());
  const log = o.log || ((m) => console.log(`${new Date().toISOString()} ${m}`));
  const alert = o.alert || (() => {});
  const { sim, fetchCandles, checkLevel, invoices, chain = null, s2 = null } = o;
  const db = new DatabaseSync(o.dbPath || ':memory:');
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, test INTEGER NOT NULL, day TEXT, chart_day TEXT NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, candles TEXT, seed TEXT, level_hash TEXT, check_hash TEXT, game_version TEXT NOT NULL,
      entry_sats INTEGER NOT NULL, max_attempts INTEGER NOT NULL, state TEXT NOT NULL, post_txid TEXT, post_height INTEGER, post_ms INTEGER, post_why TEXT,
      ready_ms INTEGER, alerted INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, created_by TEXT, closed_ms INTEGER, listed_ms INTEGER);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, round TEXT NOT NULL, player TEXT NOT NULL, ip TEXT, invoice TEXT, paid_hash TEXT UNIQUE,
      invoice_expires_ms INTEGER, created_ms INTEGER NOT NULL, started_ms INTEGER, token TEXT, deadline_ms INTEGER, submitted_ms INTEGER, log TEXT,
      log_hash TEXT, score TEXT, flags TEXT, client TEXT, state TEXT NOT NULL, why TEXT, review TEXT NOT NULL DEFAULT 'none');
    CREATE INDEX IF NOT EXISTS attempts_by_round ON attempts (round, player);
    CREATE INDEX IF NOT EXISTS attempts_by_state ON attempts (state);
    CREATE TABLE IF NOT EXISTS players (pubkey TEXT PRIMARY KEY, name TEXT, x_account TEXT, x_user_id TEXT, verified INTEGER, seen_ms INTEGER);
    CREATE TABLE IF NOT EXISTS disqualified (round TEXT NOT NULL, player TEXT NOT NULL, why TEXT NOT NULL, by TEXT, at_ms INTEGER NOT NULL, PRIMARY KEY (round, player));
    CREATE TABLE IF NOT EXISTS payout_lists (round TEXT NOT NULL, kind TEXT NOT NULL, rows TEXT NOT NULL, sats INTEGER NOT NULL, carry_sats INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, by TEXT, at_ms INTEGER, why TEXT, made_ms INTEGER NOT NULL, PRIMARY KEY (round, kind));
    CREATE TABLE IF NOT EXISTS row_rejects (round TEXT NOT NULL, kind TEXT NOT NULL, player TEXT NOT NULL, why TEXT, by TEXT, at_ms INTEGER NOT NULL, PRIMARY KEY (round, kind, player));
    CREATE TABLE IF NOT EXISTS approvals (n INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL,
      at_ms INTEGER NOT NULL, why TEXT, rows TEXT);
    CREATE TABLE IF NOT EXISTS bounty_claims (round TEXT PRIMARY KEY, player TEXT NOT NULL, ln_address TEXT NOT NULL, at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_seen (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);`);
  // PAID WHEN (kanban #3265): a run may start before its entry is paid ("pending entry"); paid_ms is when lnd settled its invoice, and only a paid
  // run is in the pot, on the board and on a list. Rows from before (paid, then started) are paid at their start
  try { db.exec('ALTER TABLE attempts ADD COLUMN paid_ms INTEGER'); db.exec("UPDATE attempts SET paid_ms = started_ms WHERE paid_ms IS NULL AND started_ms IS NOT NULL AND state IN ('started', 'scored', 'rejected', 'timeout')"); } catch { /* there already */ }
  // A CARRY IS DECIDED ONCE (kanban #3266): carry_to is the round an approved pot list's carry went into (null: none open yet, the next one takes it)
  try { db.exec('ALTER TABLE payout_lists ADD COLUMN carry_to TEXT'); } catch { /* there already */ }
  const q = (sql) => db.prepare(sql);
  const roundRow = (id) => q('SELECT * FROM rounds WHERE id = ?').get(String(id));
  const levels = new Map();   // round id -> built level
  const levelOf = (r) => { let L = levels.get(r.id); if (!L) { L = sim.buildLevel(J(r.candles), J(r.seed), r.game_version); levels.set(r.id, L); } return L; };

  // ---------- rounds ----------
  const LIVE = "state IN ('waiting', 'posting', 'ready')";
  const liveOther = (t, id = null) => q(`SELECT * FROM rounds WHERE ${LIVE} AND end_ms > ? AND id IS NOT ? ORDER BY start_ms LIMIT 1`).get(t, id);
  const nextNum = () => (q('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM rounds').get().n);
  function insertRound({ id, test, day, chartDay, startMs, endMs, by, maxAttempts = cfg.maxAttempts }) {
    q(`INSERT INTO rounds (id, num, test, day, chart_day, start_ms, end_ms, game_version, entry_sats, max_attempts, state, created_ms, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`).run(id, nextNum(), test ? 1 : 0, day, chartDay, startMs, endMs, String(sim.GAME_VERSION),
      cfg.entrySats, maxAttempts, now(), by || null);
    return roundRow(id);
  }
  /** Only one round open at a time (kanban #3256): a test round may not overlap any round, nor a daily round's day. */
  // a test round may allow more attempts (kanban #3256, maxAttempts 1..99, default 5; owner 2026-11-22: up to 99); the daily rounds keep cfg.maxAttempts (the owner's rule: 5)
  function testRound({ startMs, minutes, chartDay, by = 'admin', maxAttempts = null } = {}) {
    const t = now();
    const most = maxAttempts == null ? cfg.maxAttempts : Number(maxAttempts);
    if (!Number.isInteger(most) || most < 1 || most > TEST_ATTEMPTS_MOST) return { ok: false, why: `maxAttempts is a whole number from 1 to ${TEST_ATTEMPTS_MOST}` };
    startMs = startMs == null ? t : Number(startMs);
    minutes = Number(minutes);
    if (!Number.isSafeInteger(startMs) || startMs < t - MIN_MS) return { ok: false, why: 'the start is a time from now on (ms)' };
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > cfg.testMinutesMost) return { ok: false, why: `a test round runs 10 to ${cfg.testMinutesMost} minutes` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(chartDay)) || !Number.isFinite(dayStart(chartDay)) || dayStart(chartDay) + DAY_MS > t) return { ok: false, why: 'the chart day is a past, complete UTC day (YYYY-MM-DD)' };
    const endMs = startMs + minutes * MIN_MS;
    const live = liveOther(t);
    if (live) return { ok: false, why: `round ${live.id} is open or about to open until ${new Date(live.end_ms).toISOString()}: one round at a time` };
    const hit = q("SELECT id FROM rounds WHERE state NOT IN ('void') AND start_ms < ? AND end_ms > ? LIMIT 1").get(endMs, startMs);
    if (hit) return { ok: false, why: `that time overlaps round ${hit.id}: one round at a time` };
    if (cfg.daily && endMs > dayStart(cfg.firstDay)) {
      const d = dayOf(Math.max(startMs, dayStart(cfg.firstDay)));
      return { ok: false, why: `the daily round of ${d} runs then: one round at a time` };
    }
    const id = `test-${nextNum()}`;
    const r = insertRound({ id, test: true, day: null, chartDay, startMs, endMs, by, maxAttempts: most });
    log(`round ${id} (test) made by ${by}: ${new Date(startMs).toISOString()} for ${minutes} min, chart ${chartDay}, ${most} attempts`);
    return { ok: true, round: publicRound(r) };
  }
  /** The daily round of the day `t` falls in, made once; a live test round holds it back until it ends (one round at a time). */
  let blockedNote = null;
  function ensureDaily(t) {
    if (!cfg.daily) return null;
    const day = dayOf(t);
    if (day < cfg.firstDay || roundRow(day)) return null;
    const live = liveOther(t);
    if (live) { if (blockedNote !== `${day}/${live.id}`) { blockedNote = `${day}/${live.id}`; log(`the daily round ${day} waits: round ${live.id} is open until ${new Date(live.end_ms).toISOString()}`); } return null; }
    const s = dayStart(day);
    log(`round ${day} made (chart ${dayOf(s - DAY_MS)})`);
    return insertRound({ id: day, test: false, day, chartDay: dayOf(s - DAY_MS), startMs: s, endMs: s + DAY_MS, by: 'daily' });
  }
  async function prepare(r) {
    if (r.state !== 'waiting' || now() >= r.end_ms) return;
    try {
      let candles = J(r.candles);
      if (!candles) {   // fetched once, stored, never fetched again (kanban #3245)
        candles = await fetchCandles(r.chart_day);
        if (!Array.isArray(candles) || candles.length !== 48) throw new Error(`the chart of ${r.chart_day} is not 48 candles`);
        q('UPDATE rounds SET candles = ? WHERE id = ? AND candles IS NULL').run(JSON.stringify(candles), r.id);
        candles = J(roundRow(r.id).candles);
      }
      const c = await checkLevel(candles, r.id, { version: r.game_version });
      if (!c || !c.ok) { q('UPDATE rounds SET post_why = ? WHERE id = ?').run('the level check found no playable level', r.id); log(`round ${r.id}: the level check failed`); return; }
      const hash = levelHashOf({ gameVersion: r.game_version, seed: c.seed, candles });
      q("UPDATE rounds SET seed = ?, level_hash = ?, check_hash = ?, state = 'posting', post_why = NULL WHERE id = ? AND state = 'waiting'")
        .run(JSON.stringify(c.seed), hash, c.hash == null ? null : String(c.hash), r.id);
      log(`round ${r.id}: level ok after ${c.tries} tries, hash ${hash.slice(0, 16)}`);
    } catch (e) { q('UPDATE rounds SET post_why = ? WHERE id = ?').run(String(e.message).slice(0, 200), r.id); log(`round ${r.id}: no level yet (${e.message})`); }
  }
  const postFields = (r) => ({ test: !!r.test, number: r.num, startMs: r.start_ms, endMs: r.end_ms, entrySats: r.entry_sats, attempts: r.max_attempts,
    split: [...SPLIT], chartDay: r.chart_day, gameVersion: r.game_version, levelHash: r.level_hash });
  let posting = false;
  async function post(r) {
    if (r.state !== 'posting' || now() >= r.end_ms) return;
    if (!chain) { q("UPDATE rounds SET state = 'ready', ready_ms = ? WHERE id = ? AND state = 'posting'").run(now(), r.id); return; }
    try {
      if (!r.post_txid) {
        if (posting) return;
        posting = true;
        try {
          const txid = await chain.post(encodeRoundPost(postFields(r)).toString('hex'));
          q('UPDATE rounds SET post_txid = ?, post_ms = ?, post_why = NULL WHERE id = ? AND post_txid IS NULL').run(txid, now(), r.id);
          log(`round ${r.id}: posted on chain ${txid}`);
        } finally { posting = false; }
        return;
      }
      const s = await chain.status(r.post_txid);
      if (s && s.confirmations >= cfg.confirmations) {
        q("UPDATE rounds SET state = 'ready', ready_ms = ?, post_height = ? WHERE id = ? AND state = 'posting'").run(now(), s.height, r.id);
        log(`round ${r.id}: post confirmed at ${s.height}, open`);
      }
    } catch (e) { q('UPDATE rounds SET post_why = ? WHERE id = ?').run(String(e.message).slice(0, 200), r.id); log(`round ${r.id}: post not done (${e.message})`); }
  }
  function close(r, t) {
    q("UPDATE attempts SET state = 'timeout', why = 'not submitted in time' WHERE round = ? AND state = 'started'").run(r.id);
    q("UPDATE attempts SET state = 'expired' WHERE round = ? AND state = 'invoiced'").run(r.id);
    q("UPDATE rounds SET state = 'closed', closed_ms = ? WHERE id = ? AND state IN ('waiting', 'posting', 'ready')").run(t, r.id);
    log(`round ${r.id} closed: pot ${potOf(roundRow(r.id))} sat`);
  }

  // ---------- attempts ----------
  // THE 5 (kanban #3248, #3265): every run that opened counts for the whole round, paid or not - an unpaid run is a seen level, so runs left
  // unpaid never buy free practice before paying (the coordinator's ruling 2026-11-21). Only an invoice of the earlier flow that expired
  // before any run opened ('expired': no level was shown) does not count
  const usedBy = (round, player) => q(`SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND player = ? AND state != 'expired'`).get(round, player).n;
  const startedCount = (round) => q('SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND paid_ms IS NOT NULL').get(round).n;   // the pot: paid entries only
  const phaseOf = (r, t = now()) => (t >= r.end_ms || ['closed', 'listed'].includes(r.state) ? 'ended' : r.state !== 'ready' ? (r.state === 'posting' ? 'posting' : 'preparing')
    : t < r.start_ms ? 'soon' : t >= r.end_ms - cfg.lastCallMs ? 'last-call' : 'open');
  // CARRY (kanban #3266): a round takes a carry only from an APPROVED pot list - a waiting list can still be rebuilt to pay it, so its carry
  // is not decided yet. An approved carry goes to the first later daily round whose pot list is not final (none yet, or waiting)
  function carryTarget(fromId) {
    const f = roundRow(fromId);
    const x = f && q(`SELECT r.id FROM rounds r LEFT JOIN payout_lists l ON l.round = r.id AND l.kind = 'pot'
      WHERE r.test = 0 AND r.state != 'void' AND r.start_ms > ? AND (l.state IS NULL OR l.state = 'waiting') ORDER BY r.start_ms LIMIT 1`).get(f.start_ms);
    return x ? x.id : null;
  }
  const freeCarries = () => q("SELECT round, carry_sats FROM payout_lists WHERE kind = 'pot' AND state = 'approved' AND carry_sats > 0 AND carry_to IS NULL").all();
  function carryIn(r) {
    if (r.test) return 0;
    const pinned = q("SELECT COALESCE(SUM(carry_sats), 0) AS s FROM payout_lists WHERE kind = 'pot' AND state = 'approved' AND carry_to = ?").get(r.id).s;
    return pinned + freeCarries().filter((l) => carryTarget(l.round) === r.id).reduce((a, l) => a + l.carry_sats, 0);
  }
  /** Pin the approved carries that flow into r (before r's list is written, so the carry is in exactly one list). */
  function claimCarries(r) {
    if (r.test) return;
    for (const l of freeCarries()) if (carryTarget(l.round) === r.id) q("UPDATE payout_lists SET carry_to = ? WHERE round = ? AND kind = 'pot' AND carry_to IS NULL").run(r.id, l.round);
  }
  const potOf = (r) => r.entry_sats * startedCount(r.id) + carryIn(r);

  async function startAttempt(player, { round, ip = null } = {}) {
    const t = now();
    const r = round ? roundRow(round) : currentRound(t);
    if (!r) return { ok: false, why: 'no round is open' };
    if (r.test && !cfg.showTest) return { ok: false, why: 'no round is open' };
    const ph = phaseOf(r, t);
    if (ph === 'last-call') return { ok: false, why: 'no new attempts in the last 5 minutes of a round' };
    if (ph !== 'open') return { ok: false, why: `the round is not open (${ph})` };
    if (usedBy(r.id, player, t) >= r.max_attempts) return { ok: false, why: `all ${r.max_attempts} attempts of this round are used` };
    // THE RUN OPENS AT ONCE (kanban #3265, the owner 2026-11-21: play at once with an empty new wallet): the level, a token and the entry invoice
    // together; the invoice lives exactly as long as the run's 10 minutes, so an entry paid after the deadline is impossible
    const deadline = Math.min(t + cfg.submitMs, r.end_ms);
    const expirySeconds = Math.floor((deadline - t) / 1000);
    if (expirySeconds < 60 || t >= r.end_ms - cfg.lastCallMs) return { ok: false, why: 'no new attempts in the last 5 minutes of a round' };
    let inv;
    try { inv = await invoices.create({ sats: r.entry_sats, memo: `Orange Pill Run ${r.id} entry`, expirySeconds }); }
    catch (e) { log(`entry invoice not made: ${e.message}`); return { ok: false, why: 'the entry invoice could not be made - try again in a minute' }; }
    // the count again after the wait: two starts at once never make a sixth
    if (usedBy(r.id, player, now()) >= r.max_attempts) return { ok: false, why: `all ${r.max_attempts} attempts of this round are used` };
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    q(`INSERT INTO attempts (id, round, player, ip, invoice, paid_hash, invoice_expires_ms, created_ms, started_ms, token, deadline_ms, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, r.id, player, ip, inv.invoice, inv.hash, t + expirySeconds * 1000, t, t, token, deadline);
    q('INSERT INTO players (pubkey, seen_ms) VALUES (?, ?) ON CONFLICT (pubkey) DO UPDATE SET seen_ms = excluded.seen_ms').run(player, t);
    return { ok: true, attempt: id, state: 'pending-entry', invoice: inv.invoice, sats: r.entry_sats, expiresMs: t + expirySeconds * 1000,
      token, startedMs: t, deadlineMs: deadline, level: levelFor(r) };
  }
  const levelFor = (r) => ({ round: r.id, chartDay: r.chart_day, candles: J(r.candles), seed: J(r.seed), gameVersion: r.game_version, levelHash: r.level_hash });
  /**
   * THE ENTRY, READ FROM LND (kanban #3248, #3265). A run's invoice settled for the whole entry before its deadline: the run is paid (paid_ms) - a
   * pending run is started, a submitted one waiting for its entry is scored and goes on the board. Not settled once the deadline passed (the
   * invoice has expired with it): "entry not paid" - not ranked, not in the pot. A row of the earlier flow ('invoiced': paid first, then the
   * token) is still settled as it was.
   */
  async function settle(a) {
    const open = ['pending', 'awaiting'].includes(a.state) || (a.state === 'rejected' && a.paid_ms == null && a.paid_hash);
    if (a.state !== 'invoiced' && !open) return a;
    let l;
    try { l = await invoices.lookup(a.paid_hash); } catch (e) { log(`invoice ${String(a.paid_hash).slice(0, 12)} not read: ${e.message}`); return a; }
    const t = now(), r = roundRow(a.round);
    if (open) {
      const paidAt = Number.isFinite(l.settleMs) && l.settleMs > 0 ? l.settleMs : Math.min(t, a.deadline_ms);   // no settle time read: lnd's expiry (= the deadline) vouches
      if (l.state === 'SETTLED' && l.paidMsat >= r.entry_sats * 1000 && paidAt <= a.deadline_ms + 5000) {
        const next = a.state === 'pending' ? 'started' : a.state === 'awaiting' ? 'scored' : a.state;
        if (q('UPDATE attempts SET paid_ms = ?, state = ? WHERE id = ? AND state = ? AND paid_ms IS NULL').run(Math.min(paidAt, t), next, a.id, a.state).changes) {
          log(`attempt ${a.id.slice(0, 8)} of ${a.round}: entry paid${next === 'scored' ? ', run scored' : ''}`);
          if (next === 'scored' && r.state === 'listed') refreshLists(r.id);
        }
      } else if (t > a.deadline_ms && a.state !== 'rejected') {   // the invoice expired with the deadline: not paid (or not in full) for good
        q("UPDATE attempts SET state = 'unpaid', why = 'entry not paid - this run does not count' WHERE id = ? AND state = ? AND paid_ms IS NULL").run(a.id, a.state);
      }
      return q('SELECT * FROM attempts WHERE id = ?').get(a.id);
    }
    if (l.state === 'SETTLED' && l.paidMsat >= r.entry_sats * 1000) {
      const deadline = Math.min(t + cfg.submitMs, r.end_ms);
      q("UPDATE attempts SET state = 'started', started_ms = ?, paid_ms = ?, token = ?, deadline_ms = ? WHERE id = ? AND state = 'invoiced'").run(t, t, randomBytes(32).toString('hex'), deadline, a.id);
    } else if (l.state === 'CANCELED' || (l.state !== 'SETTLED' && t > a.invoice_expires_ms + 60000)) {
      q("UPDATE attempts SET state = 'expired' WHERE id = ? AND state = 'invoiced'").run(a.id);
    }
    return q('SELECT * FROM attempts WHERE id = ?').get(a.id);
  }
  async function checkAttempt(player, id) {
    let a = q('SELECT * FROM attempts WHERE id = ?').get(String(id || ''));
    if (!a || a.player !== player) return { ok: false, why: 'no such attempt of yours' };
    a = await settle(a);
    const r = roundRow(a.round);
    if (a.state === 'invoiced') return { ok: true, state: 'invoiced', invoice: a.invoice, expiresMs: a.invoice_expires_ms };
    if (a.state === 'pending' && now() <= a.deadline_ms) return { ok: true, state: 'pending-entry', paid: false, invoice: a.invoice, expiresMs: a.invoice_expires_ms, token: a.token, startedMs: a.started_ms, deadlineMs: a.deadline_ms, level: levelFor(r) };
    if (a.state === 'awaiting') return { ok: true, state: 'pending-entry', paid: false, submitted: true, invoice: a.invoice, deadlineMs: a.deadline_ms, score: J(a.score) };
    if (a.state === 'unpaid') return { ok: true, state: 'entry-not-paid', paid: false, why: a.why, score: J(a.score) };
    if (a.state === 'started' && now() < a.deadline_ms) return { ok: true, state: 'started', paid: true, token: a.token, startedMs: a.started_ms, deadlineMs: a.deadline_ms, level: levelFor(r) };
    return { ok: true, state: a.state, paid: a.paid_ms != null, why: a.why || null, score: J(a.score) };
  }

  function submit(player, body = {}, { ip = null } = {}) {
    const t = now();
    const a = q('SELECT * FROM attempts WHERE id = ?').get(String(body.attempt || ''));
    const tok = String(body.token || '');
    if (!a || !a.token || tok.length !== a.token.length || !timingSafeEqual(Buffer.from(tok), Buffer.from(a.token))) return { ok: false, why: 'unknown token' };
    if (a.player !== player) return { ok: false, why: 'that token is not yours' };
    if (body.round != null && String(body.round) !== a.round) return { ok: false, why: 'that token is of another round' };
    if (a.state !== 'started' && a.state !== 'pending') return { ok: false, why: a.state === 'unpaid' ? 'entry not paid - this run does not count' : 'that token was used already' };
    const r = roundRow(a.round);
    const from = a.state;
    const reject = (why, extra = {}) => {
      q("UPDATE attempts SET state = 'rejected', why = ?, submitted_ms = ?, log = ?, client = ?, flags = ? WHERE id = ? AND state = ?")
        .run(why, t, body.log == null ? null : JSON.stringify(body.log).slice(0, cfg.bodyMost), JSON.stringify(body.client || {}).slice(0, 2000), JSON.stringify(extra.flags || {}), a.id, from);
      log(`attempt ${a.id.slice(0, 8)} of ${a.round} refused: ${why}`);
      return { ok: false, why, closed: true };
    };
    if (t > a.deadline_ms) { if (from === 'started') q("UPDATE attempts SET state = 'timeout', why = 'not submitted in time' WHERE id = ? AND state = 'started'").run(a.id); return { ok: false, why: 'the 10 minutes of this attempt are over', closed: true }; }
    const bad = logRefusal(body.log, { maxSteps: cfg.maxSteps, most: cfg.logPressesMost });
    if (bad) return reject(`malformed log: ${bad}`);
    if (body.log.v !== r.game_version) return reject(`wrong game version: the round plays ${r.game_version}`);
    let res;
    try { res = sim.runLog(levelOf(r), body.log, { maxSteps: cfg.maxSteps }); } catch (e) { return reject(`the log does not replay (${String(e.message).slice(0, 80)})`); }
    if (!res || !Number.isSafeInteger(res.steps) || !Number.isFinite(res.total)) return reject('the log does not replay');
    const gameMs = (res.steps * 1000) / 60;
    if (t - a.started_ms + cfg.fastSlackMs < gameMs) return reject(`submitted faster than the run's game time (${Math.round(gameMs / 1000)} s)`, { flags: { tooFast: true } });
    const score = { total: res.total, parts: res.parts, clean: !!res.clean, finished: !!res.finished, steps: res.steps, deaths: res.deaths, timeS: res.timeS };
    const logHash = sha(JSON.stringify(body.log.presses));
    const flags = runSignals(body.log, body.client);
    const same = q("SELECT id, player FROM attempts WHERE round = ? AND log_hash = ? AND player != ? AND state = 'scored'").all(a.round, logHash, player);
    if (same.length) {
      flags.sameLog = true;
      for (const s of same) { const f = J(q('SELECT flags FROM attempts WHERE id = ?').get(s.id).flags, {}); f.sameLog = true; q("UPDATE attempts SET flags = ?, review = CASE review WHEN 'cleared' THEN 'cleared' ELSE 'pending' END WHERE id = ?").run(JSON.stringify(f), s.id); }
    }
    if (ip) {
      const n = q('SELECT COUNT(DISTINCT player) AS n FROM attempts WHERE round = ? AND ip = ?').get(a.round, ip).n;
      if (n >= cfg.ipCrowd) flags.ipCrowd = n;
    }
    const review = Object.keys(flags).length ? 'pending' : 'none';
    // a run whose entry is not paid yet is kept with its score, waiting: it is placed only once the entry settles before the deadline (#3265)
    const to = from === 'started' ? 'scored' : 'awaiting';
    const done = q(`UPDATE attempts SET state = ?, submitted_ms = ?, log = ?, log_hash = ?, score = ?, flags = ?, client = ?, review = ? WHERE id = ? AND state = ?`)
      .run(to, t, JSON.stringify(body.log), logHash, JSON.stringify(score), JSON.stringify(flags), JSON.stringify(body.client || {}).slice(0, 2000), review, a.id, from);
    if (!done.changes) return { ok: false, why: 'that token was used already' };
    if (to === 'scored' && r.state === 'listed') refreshLists(r.id);
    return { ok: true, attempt: a.id, score, paid: to === 'scored', state: to === 'scored' ? 'scored' : 'pending-entry' };
  }
  /** Submit over the wire (kanban #3265): the entry is read from lnd before and, for a run still waiting for it, again after. */
  async function submitChecked(player, body = {}, opts = {}) {
    let a = q('SELECT * FROM attempts WHERE id = ?').get(String(body.attempt || ''));
    if (a && a.player === player && a.state === 'pending') await settle(a);
    const out = submit(player, body, opts);
    a = q('SELECT * FROM attempts WHERE id = ?').get(String(body.attempt || ''));
    if (out.ok && a && a.state === 'awaiting') {
      a = await settle(a);
      if (a.state === 'scored') return { ...out, paid: true, state: 'scored' };
    }
    return out;
  }

  // ---------- board, players, placement ----------
  const nameOf = (pk) => { const p = q('SELECT name FROM players WHERE pubkey = ?').get(pk); return (p && p.name) || `player ${pk.slice(0, 8)}`; };
  const dq = (round) => new Set(q('SELECT player FROM disqualified WHERE round = ?').all(round).map((x) => x.player));
  function runsOf(round) {
    const out = dq(round);
    return q("SELECT * FROM attempts WHERE round = ? AND state = 'scored'").all(round).filter((a) => !out.has(a.player)).map((a) => {
      const s = J(a.score, {});
      return { attempt: a.id, player: a.player, total: s.total, timeS: s.timeS, submittedMs: a.submitted_ms, finished: s.finished, clean: s.clean, deaths: s.deaths, flags: J(a.flags, {}), review: a.review };
    });
  }
  function boardOf(round) { return bestPerPlayer(runsOf(round)).map((b) => ({ ...b, name: nameOf(b.player) })); }
  /** PLACED (kanban #3245, #3250): a linked X account the bug bounty verified (Season 2 links, its own flow), not a known bot there. */
  function xOf(pk) {
    if (!s2) return { placed: false, x: null, why: 'no X check here' };
    let l = null, flags = {};
    try { l = s2.links(pk).find((x) => x.platform === 'x') || null; flags = s2.flagsOf(pk) || {}; } catch (e) { return { placed: false, x: null, why: `X not read (${e.message})` }; }
    if (!l) return { placed: false, x: null, why: 'no X account linked' };
    const x = { userId: String(l.userId), username: l.username || null };
    if (flags.bot) return { placed: false, x, why: 'a known bot account' };
    if (l.member !== true) return { placed: false, x, why: 'the X account is not verified yet' };
    return { placed: true, x, why: null };
  }
  function publicBoard(round, viewer = null) {
    const r = roundRow(round);
    const ended = now() >= r.end_ms;
    const used = new Map(q('SELECT player, COUNT(*) AS n FROM attempts WHERE round = ? AND paid_ms IS NOT NULL GROUP BY player').all(round).map((x) => [x.player, x.n]));
    return boardOf(round).map((b) => ({ rank: b.rank, name: b.name, player: b.player, score: b.total, timeS: b.timeS, attempts: used.get(b.player) || 0,
      placed: xOf(b.player).placed, replay: (ended && b.rank <= 10) || b.player === viewer ? `/replay/${b.attempt}` : null }));
  }

  // ---------- payout lists ----------
  function buildLists(r) {
    const board = boardOf(r.id);
    const rejected = (kind) => new Set(q('SELECT player FROM row_rejects WHERE round = ? AND kind = ?').all(r.id, kind).map((x) => x.player));
    const make = (kind) => {
      const rj = rejected(kind);
      return payoutLists({ board, potSats: potOf(r), placedOf: xOf, bountySats: cfg.bountySats, test: !!r.test,
        held: (p) => { const b = board.find((x) => x.player === p); return rj.has(p) ? 'row rejected' : b && b.review === 'pending' ? 'under review' : null; } });
    };
    return { pot: make('pot').pot, bounty: make('bounty').bounty };
  }
  function writeList(r, kind, list, t) {
    if (!list) return;
    const had = q('SELECT state FROM payout_lists WHERE round = ? AND kind = ?').get(r.id, kind);
    if (had && had.state !== 'waiting') return;   // an approved or rejected list is never rewritten
    const sats = list.rows.reduce((a, x) => a + x.sats, 0);
    q(`INSERT INTO payout_lists (round, kind, rows, sats, carry_sats, state, made_ms) VALUES (?, ?, ?, ?, ?, 'waiting', ?)
       ON CONFLICT (round, kind) DO UPDATE SET rows = excluded.rows, sats = excluded.sats, carry_sats = excluded.carry_sats, made_ms = excluded.made_ms`)
      .run(r.id, kind, JSON.stringify(list.rows), sats, list.carrySats || 0, t);
  }
  function refreshLists(round) {
    const r = roundRow(round);
    if (!r || r.state !== 'listed') return;
    claimCarries(r);
    const l = buildLists(r), t = now();
    writeList(r, 'pot', l.pot, t); writeList(r, 'bounty', l.bounty, t);
  }
  function makeLists(r, t) {
    claimCarries(r);
    const l = buildLists(r);
    writeList(r, 'pot', l.pot, t); writeList(r, 'bounty', l.bounty, t);
    q("UPDATE rounds SET state = 'listed', listed_ms = ? WHERE id = ? AND state = 'closed'").run(t, r.id);
    const rows = (x) => (x ? x.rows.map((w) => `${w.place}. ${w.xAccount || w.player.slice(0, 8)} ${w.sats} sat`).join(', ') || 'nobody placed' : '');
    alert(`Orange Pill Run ${r.id}${r.test ? ' (test)' : ''}: payout lists wait for sign-off - pot ${l.pot.potSats} sat: ${rows(l.pot)}${l.bounty ? `; bounty: ${rows(l.bounty)}` : ''}`);
    log(`round ${r.id}: payout lists written (waiting for sign-off)`);
  }
  const listRow = (x) => (x ? { round: x.round, kind: x.kind, rows: J(x.rows, []), sats: x.sats, carrySats: x.carry_sats, state: x.state, by: x.by, atMs: x.at_ms, why: x.why, madeMs: x.made_ms } : null);
  const listsOf = (round) => q('SELECT * FROM payout_lists WHERE round = ? ORDER BY kind DESC').all(round).map(listRow);
  /** THE POT NEVER PAYS MORE THAN WAS PAID IN (kanban #3266): over the approved pot lists (plus `also`, a list about to be approved), what they
   *  commit - rows paid plus carries not taken into another approved list - against the paid entries of their rounds. */
  function potLedger(also = null) {
    const lists = q("SELECT * FROM payout_lists WHERE kind = 'pot'").all().filter((l) => l.state === 'approved' || l.round === also);
    const ids = new Set(lists.map((l) => l.round));
    let committed = 0, entries = 0;
    for (const l of lists) {
      committed += l.sats + (l.carry_to && ids.has(l.carry_to) ? 0 : l.carry_sats);
      const r = roundRow(l.round); entries += r ? r.entry_sats * startedCount(r.id) : 0;
    }
    return { committed, entries, why: committed > entries ? `the approved pot lists would commit ${committed} pot sats (paid or carried), more than the ${entries} sat of paid entries of their rounds` : null };
  }
  function decideList({ round, kind, action, by, why = null } = {}) {
    const l = q('SELECT * FROM payout_lists WHERE round = ? AND kind = ?').get(String(round), String(kind));
    if (!l) return { ok: false, why: 'no such list' };
    if (!['approve', 'reject'].includes(action)) return { ok: false, why: 'approve or reject' };
    if (!by || !String(by).trim()) return { ok: false, why: 'who signs off (by)' };
    if (l.state !== 'waiting') return { ok: false, why: `the list is ${l.state} already` };
    if (action === 'approve' && l.kind === 'pot') { const g = potLedger(l.round); if (g.why) { log(`payout list ${l.round}/pot not approved: ${g.why}`); return { ok: false, why: g.why }; } }
    const t = now(), state = action === 'approve' ? 'approved' : 'rejected';
    q('UPDATE payout_lists SET state = ?, by = ?, at_ms = ?, why = ? WHERE round = ? AND kind = ? AND state = \'waiting\'').run(state, String(by).slice(0, 80), t, why ? String(why).slice(0, 300) : null, l.round, l.kind);
    q('INSERT INTO approvals (round, kind, action, by, at_ms, why, rows) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.round, l.kind, state, String(by).slice(0, 80), t, why ? String(why).slice(0, 300) : null, l.rows);
    log(`payout list ${l.round}/${l.kind} ${state} by ${by}`);
    if (state === 'approved' && l.kind === 'pot' && l.carry_sats > 0) {   // the carry is decided now: into the next round whose list is not final
      const to = carryTarget(l.round);
      if (to) { q("UPDATE payout_lists SET carry_to = ? WHERE round = ? AND kind = 'pot'").run(to, l.round); refreshLists(to); log(`round ${l.round}: carry ${l.carry_sats} sat into ${to}`); }
    }
    return { ok: true, list: listRow(q('SELECT * FROM payout_lists WHERE round = ? AND kind = ?').get(l.round, l.kind)) };
  }
  function rejectRow({ round, kind, player, why = null, by } = {}) {
    const l = q('SELECT * FROM payout_lists WHERE round = ? AND kind = ?').get(String(round), String(kind));
    if (!l || l.state !== 'waiting') return { ok: false, why: 'no waiting list' };
    if (!by) return { ok: false, why: 'who decides (by)' };
    q('INSERT OR REPLACE INTO row_rejects (round, kind, player, why, by, at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(l.round, l.kind, String(player), why, String(by).slice(0, 80), now());
    q('INSERT INTO approvals (round, kind, action, by, at_ms, why, rows) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.round, l.kind, `row-rejected ${String(player).slice(0, 64)}`, String(by).slice(0, 80), now(), why, null);
    refreshLists(l.round);
    return { ok: true, lists: listsOf(l.round) };
  }
  function disqualify({ round, player, why, by = 'admin' } = {}) {
    if (!roundRow(round)) return { ok: false, why: 'no such round' };
    if (!why || !String(why).trim()) return { ok: false, why: 'a disqualification needs a reason' };
    q('INSERT OR REPLACE INTO disqualified (round, player, why, by, at_ms) VALUES (?, ?, ?, ?, ?)').run(String(round), String(player), String(why).slice(0, 300), String(by).slice(0, 80), now());
    log(`player ${String(player).slice(0, 8)} disqualified in ${round} by ${by}: ${why}`);
    refreshLists(String(round));
    return { ok: true, lists: listsOf(String(round)) };
  }
  function review({ attempt, action, by = 'admin' } = {}) {
    const a = q('SELECT * FROM attempts WHERE id = ?').get(String(attempt || ''));
    if (!a) return { ok: false, why: 'no such attempt' };
    if (!['clear', 'hold'].includes(action)) return { ok: false, why: 'clear or hold' };
    q('UPDATE attempts SET review = ? WHERE id = ?').run(action === 'clear' ? 'cleared' : 'pending', a.id);
    log(`attempt ${a.id.slice(0, 8)} review ${action} by ${by}`);
    refreshLists(a.round);
    return { ok: true };
  }
  /** What may be paid: approved lists only, each with its approval record (who, when). */
  function payable() {
    const g = potLedger();
    if (g.why) throw new Error(g.why);
    return q("SELECT * FROM payout_lists WHERE state = 'approved' ORDER BY at_ms").all().map(listRow)
    .map((l) => ({ ...l, approval: q("SELECT by, at_ms AS atMs FROM approvals WHERE round = ? AND kind = ? AND action = 'approved' ORDER BY n DESC LIMIT 1").get(l.round, l.kind) || null }))
    .filter((l) => l.approval && l.approval.by);
  }
  function claimBounty(player, { round, lnAddress } = {}) {
    const r = roundRow(round);
    if (!r || r.test) return { ok: false, why: 'no bounty in that round' };
    const l = q("SELECT * FROM payout_lists WHERE round = ? AND kind = 'bounty'").get(r.id);
    const row = l && J(l.rows, [])[0];
    if (!row || row.player !== player) return { ok: false, why: 'the bounty of that round is not yours' };
    if (now() > r.end_ms + cfg.bountyClaimMs) return { ok: false, why: 'the bounty expired (7 days after the round)' };
    if (!/^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(String(lnAddress || ''))) return { ok: false, why: 'that is not a Lightning address (name@domain)' };
    q('INSERT OR REPLACE INTO bounty_claims (round, player, ln_address, at_ms) VALUES (?, ?, ?, ?)').run(r.id, player, String(lnAddress).toLowerCase(), now());
    return { ok: true };
  }

  // ---------- the clock ----------
  function currentRound(t = now()) {
    const vis = cfg.showTest ? '' : 'AND test = 0';
    return q(`SELECT * FROM rounds WHERE start_ms <= ? AND end_ms > ? ${vis} ORDER BY start_ms DESC LIMIT 1`).get(t, t)
      || q(`SELECT * FROM rounds WHERE start_ms > ? ${vis} ORDER BY start_ms LIMIT 1`).get(t)
      || q(`SELECT * FROM rounds WHERE 1 ${vis} ORDER BY end_ms DESC LIMIT 1`).get() || null;
  }
  let ticking = false;
  const alertedDays = new Set();
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const t = now();
      ensureDaily(t);
      for (const r of q("SELECT * FROM rounds WHERE state = 'waiting' AND end_ms > ?").all(t)) await prepare(r);
      for (const r of q("SELECT * FROM rounds WHERE state = 'posting' AND end_ms > ?").all(now())) await post(roundRow(r.id));
      for (const r of q(`SELECT * FROM rounds WHERE ${LIVE} AND test = 0 AND alerted = 0 AND state != 'ready' AND start_ms + ? <= ?`).all(cfg.alertAfterMs, now())) {
        q('UPDATE rounds SET alerted = 1 WHERE id = ?').run(r.id);
        alert(`Orange Pill Run ${r.id}: no round open ${Math.round(cfg.alertAfterMs / MIN_MS)} min after the start (${r.state}${r.post_why ? `: ${r.post_why}` : ''})`);
      }
      if (cfg.daily) {   // no round at all by the alert time (the daily one held back or never made)
        const d = dayOf(now()), s = dayStart(d);
        if (d >= cfg.firstDay && now() >= s + cfg.alertAfterMs && !roundRow(d) && !alertedDays.has(d)) { alertedDays.add(d); alert(`Orange Pill Run ${d}: no daily round by ${new Date(s + cfg.alertAfterMs).toISOString().slice(11, 16)}Z`); }
      }
      for (const a of q(`SELECT * FROM attempts WHERE state IN ('invoiced', 'pending', 'awaiting') OR (state = 'rejected' AND paid_ms IS NULL AND paid_hash IS NOT NULL AND deadline_ms > ?)
          ORDER BY created_ms LIMIT 100`).all(now() - 60000)) await settle(a);
      q("UPDATE attempts SET state = 'timeout', why = 'not submitted in time' WHERE state = 'started' AND deadline_ms < ?").run(now());
      for (const r of q(`SELECT * FROM rounds WHERE ${LIVE} AND end_ms <= ?`).all(now())) close(r, now());
      for (const r of q("SELECT * FROM rounds WHERE state = 'closed' AND end_ms + ? <= ?").all(cfg.verifyGraceMs, now())) makeLists(r, now());
      q('DELETE FROM auth_seen WHERE at_ms < ?').run(now() - 5 * MIN_MS);
    } finally { ticking = false; }
  }

  function publicRound(r, t = now()) {
    if (!r) return null;
    const board = boardOf(r.id), best = board[0];
    return { id: r.id, number: r.num, test: !!r.test, chartDay: r.chart_day, startMs: r.start_ms, endMs: r.end_ms, phase: phaseOf(r, t), lastCallMs: r.end_ms - cfg.lastCallMs,
      entrySats: r.entry_sats, maxAttempts: r.max_attempts, split: [...SPLIT], potSats: potOf(r), bountySats: r.test ? 0 : cfg.bountySats,
      gameVersion: r.game_version, levelHash: r.level_hash, players: board.length,
      post: { txid: r.post_txid, height: r.post_height, confirmed: r.state !== 'waiting' && r.state !== 'posting' && (!!r.post_height || !chain) },
      best: best ? { score: best.total, timeS: best.timeS, name: best.name } : null };
  }

  // ---------- HTTP ----------
  const seenAuth = (id) => { try { q('INSERT INTO auth_seen (id, at_ms) VALUES (?, ?)').run(id, now()); return false; } catch { return true; } };
  /** WHO ASKS (NIP-98, the feedback sign-in's kind 27235): signed within a minute, naming this URL and method, the body's hash on a POST, used once. */
  function authOf(req, path, body) {
    let e = null;
    try { const h = String(req.headers.authorization || ''); if (h.startsWith('Nostr ')) e = JSON.parse(Buffer.from(h.slice(6), 'base64').toString('utf8')); } catch { e = null; }
    if (!e) return { ok: false, why: 'sign in first (NIP-98)' };
    const nowS = Math.floor(now() / 1000);
    const refused = eventRefusal(e, { kinds: [HTTP_AUTH_KIND], nowS });
    if (refused) return { ok: false, why: refused.startsWith('blocked:') ? 'that is not a sign-in (NIP-98)' : refused };
    if (Math.abs(nowS - e.created_at) > AUTH_AGE_MOST_S) return { ok: false, why: 'that sign-in is older than a minute' };
    const tag = (n) => { const x = e.tags.find((t) => t[0] === n); return x ? x[1] : null; };
    if (!cfg.publicBases.some((b) => tag('u') === b + path) || String(tag('method') || '').toUpperCase() !== req.method) return { ok: false, why: 'that sign-in names another address or method' };
    if (req.method === 'POST' && tag('payload') !== sha(body)) return { ok: false, why: 'that sign-in is for another body' };
    if (seenAuth(e.id)) return { ok: false, why: 'that sign-in was used already' };
    return { ok: true, pubkey: e.pubkey };
  }
  const adminSha = String(cfg.adminSha || '').trim().toLowerCase();
  const fails = new Map();
  const isAdminCode = (code) => /^[0-9a-f]{64}$/.test(adminSha) && !!code && timingSafeEqual(Buffer.from(sha(code)), Buffer.from(adminSha));
  function adminGate(req, ip) {
    const who = `admin:${ip || 'unnamed'}`, t = now();
    for (const [k, v] of fails) if (t - v.since > ADMIN_TRY_WINDOW_MS) fails.delete(k);
    const mine = fails.get(who), all = fails.get('admin:*');
    if ((mine && mine.n >= ADMIN_TRIES_PER_CALLER) || (all && all.n >= ADMIN_TRIES_ALL)) return [429, 'too many wrong admin codes - try again later'];
    if (!isAdminCode(String(req.headers['x-arena-admin'] || '').trim())) {
      for (const k of [who, 'admin:*']) { const v = fails.get(k) || { n: 0, since: t }; v.n++; fails.set(k, v); }
      return [403, 'not the admin code'];
    }
    return null;
  }
  const fromWorker = (req) => { const k = String(req.headers['x-arena-worker'] || ''); return !!cfg.workerKey && k.length === cfg.workerKey.length && timingSafeEqual(Buffer.from(k), Buffer.from(cfg.workerKey)); };
  const ipOf = (req) => (fromWorker(req) ? String(req.headers['x-arena-ip'] || '').trim() || null : (req.socket && req.socket.remoteAddress) || null);
  const visible = (r) => r && (cfg.showTest || !r.test);

  async function handle(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://opr');
      const path = url.pathname.replace(/^\/api\/opr/, '') || '/';
      let raw = '';
      if (req.method === 'POST') {
        for await (const c of req) { raw += c; if (raw.length > cfg.bodyMost) return send(413, { ok: false, why: 'too big' }); }
      }
      const body = J(raw, {}) || {};
      const ip = ipOf(req);
      if (path.startsWith('/admin/')) {
        const g = adminGate(req, ip);
        if (g) return send(g[0], { ok: false, why: g[1] });
        const by = String(body.by || 'admin').slice(0, 80);
        if (req.method === 'GET' && path === '/admin/rounds') return send(200, { ok: true, rounds: q('SELECT * FROM rounds ORDER BY start_ms DESC LIMIT 60').all().map((r) => ({ ...publicRound(r), state: r.state, postWhy: r.post_why })) });
        if (req.method === 'GET' && path === '/admin/runs') {
          const round = url.searchParams.get('round'), player = url.searchParams.get('player');
          const rows = q('SELECT * FROM attempts WHERE round = ? ORDER BY created_ms').all(String(round)).filter((a) => !player || a.player === player);
          const out = dq(String(round));
          return send(200, { ok: true, runs: rows.map((a) => ({ attempt: a.id, player: a.player, name: nameOf(a.player), state: a.state, why: a.why, score: J(a.score), flags: J(a.flags, {}),
            review: a.review, ip: a.ip, startedMs: a.started_ms, submittedMs: a.submitted_ms, client: J(a.client), x: xOf(a.player), disqualified: out.has(a.player), replay: `/replay/${a.id}` })),
            disqualified: q('SELECT * FROM disqualified WHERE round = ?').all(String(round)) });
        }
        if (req.method === 'GET' && path === '/admin/lists') return send(200, { ok: true, lists: listsOf(String(url.searchParams.get('round'))), approvals: q('SELECT * FROM approvals WHERE round = ? ORDER BY n').all(String(url.searchParams.get('round'))), claim: q('SELECT * FROM bounty_claims WHERE round = ?').get(String(url.searchParams.get('round'))) || null });
        if (req.method === 'GET' && path === '/admin/payable') { try { return send(200, { ok: true, lists: payable() }); } catch (e) { alert(`Orange Pill Run: payable refused - ${e.message}`); return send(409, { ok: false, why: e.message }); } }
        if (req.method === 'POST' && path === '/admin/disqualify') { const r = disqualify({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/review') { const r = review({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/list') { const r = decideList({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/row') { const r = rejectRow({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/test-round') { const r = testRound({ ...body, by }); if (r.ok) tick().catch(() => {}); return send(r.ok ? 200 : 400, r); }
        return send(404, { ok: false, why: 'no such admin route' });
      }
      if (req.method === 'GET' && path === '/round') {
        const r = url.searchParams.get('id') ? roundRow(url.searchParams.get('id')) : currentRound();
        return visible(r) ? send(200, { ok: true, round: publicRound(r) }) : send(404, { ok: false, why: 'no round' });
      }
      if (req.method === 'GET' && path === '/rounds') return send(200, { ok: true, rounds: q(`SELECT * FROM rounds ${cfg.showTest ? '' : 'WHERE test = 0'} ORDER BY start_ms DESC LIMIT 30`).all().map((r) => publicRound(r)) });
      if (req.method === 'GET' && path === '/board') {
        const r = url.searchParams.get('round') ? roundRow(url.searchParams.get('round')) : currentRound();
        if (!visible(r)) return send(404, { ok: false, why: 'no round' });
        return send(200, { ok: true, round: publicRound(r), board: publicBoard(r.id).map(({ player, ...x }) => x) });
      }
      const rm = /^\/replay\/([0-9a-f]{32})$/.exec(path);
      if (req.method === 'GET' && rm) {
        const a = q("SELECT * FROM attempts WHERE id = ? AND state IN ('scored', 'rejected')").get(rm[1]);
        const r = a && roundRow(a.round);
        if (!a || !visible(r)) return send(404, { ok: false, why: 'no such run' });
        let viewer = null;
        if (req.headers.authorization) { const w = authOf(req, path, raw); if (w.ok) viewer = w.pubkey; }
        const top = now() >= r.end_ms && boardOf(r.id).some((b) => b.attempt === a.id && b.rank <= 10);
        if (!top && viewer !== a.player) return send(403, { ok: false, why: 'replays of a round are public after it ends, for its top 10; your own runs always' });
        return send(200, { ok: true, attempt: a.id, name: nameOf(a.player), log: J(a.log), score: J(a.score), level: levelFor(r) });
      }
      // signed-in doors
      const who = authOf(req, path, raw);
      if (!who.ok) return send(401, { ok: false, why: who.why });
      const me = who.pubkey;
      if (req.method === 'GET' && path === '/me') {
        const r = url.searchParams.get('round') ? roundRow(url.searchParams.get('round')) : currentRound();
        const x = xOf(me);
        const mine = r ? q('SELECT * FROM attempts WHERE round = ? AND player = ? ORDER BY created_ms').all(r.id, me) : [];
        return send(200, { ok: true, pubkey: me, name: nameOf(me), x: x.x ? { username: x.x.username } : null, placed: x.placed, placedWhy: x.placed ? null : x.why,
          round: r ? r.id : null, used: r ? usedBy(r.id, me, now()) : 0, maxAttempts: r ? r.max_attempts : cfg.maxAttempts,
          attempts: mine.map((a) => ({ attempt: a.id, state: a.state === 'pending' || a.state === 'awaiting' ? 'pending-entry' : a.state === 'unpaid' ? 'entry-not-paid' : a.state,
            paid: a.paid_ms != null, why: a.why, score: J(a.score), startedMs: a.started_ms })) });
      }
      if (req.method === 'POST' && path === '/name') {
        const n = String(body.name || '').trim();
        if (!/^[A-Za-z0-9 _.-]{2,20}$/.test(n)) return send(400, { ok: false, why: 'a name is 2 to 20 letters, digits, space, _ . -' });
        q('INSERT INTO players (pubkey, name, seen_ms) VALUES (?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name').run(me, n, now());
        return send(200, { ok: true, name: n });
      }
      if (req.method === 'POST' && path === '/attempt') { const r = await startAttempt(me, { round: body.round, ip }); return send(r.ok ? 200 : 409, r); }
      if (req.method === 'POST' && path === '/attempt/check') { const r = await checkAttempt(me, body.attempt); return send(r.ok ? 200 : 404, r); }
      if (req.method === 'POST' && path === '/submit') { const r = await submitChecked(me, body, { ip }); return send(r.ok ? 200 : 409, r); }
      if (req.method === 'POST' && path === '/claim') { const r = claimBounty(me, body); return send(r.ok ? 200 : 409, r); }
      return send(404, { ok: false, why: 'no such route' });
    } catch (e) { log(`request failed: ${e.stack || e.message}`); return send(500, { ok: false, why: 'the round service failed on that' }); }
  }

  return { db, cfg, tick, handle, testRound, ensureDaily, startAttempt, checkAttempt, submit, submitChecked, settle, boardOf, publicBoard, publicRound, currentRound, roundRow: (id) => roundRow(id),
    potOf: (id) => potOf(roundRow(id)), listsOf, decideList, rejectRow, disqualify, review, payable, claimBounty, xOf, postFields: (id) => postFields(roundRow(id)), close: () => db.close() };
}
