// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORANGE PILL RUN ROUND SERVICE (kanban #3245; #3248 rounds, entry, attempts, board, pot; #3249 server-checked scores, bot signals, replays;
// #3250 X placement, bounty, payout lists with sign-off; #3256 rounds posted on chain, test rounds). One process, one node:sqlite file.
// Everything it needs from outside is handed in, so tests run it with fakes:
//   sim { buildLevel(candles, seed, version), runLog(L, log, { maxSteps }), GAME_VERSION }   (src/sim, the same code the page runs; with newWorld,
//       stepWorld, botInput too the bot likelihood also measures the reactions to hazards on the replayed world, kanban #3274)
//   fetchCandles(day) -> 48 candles of that UTC day                                  (src/candles.mjs)
//   checkLevel(candles, roundId, { version }) -> { ok, seed, tries, hash }                  (src/level-check.mjs)
//   invoices { create, lookup }                                                      (opr-invoices.mjs: one testnet4 lnd)
//   chain { post(payloadHex) -> txid, status(txid) -> { confirmations, height } }    (opr-chain.mjs; null: no post, a round opens on its level)
//   xLookup(handle) -> { userId, username, why }: whether an X account of that name exists (arena-node/src/bounty-verify.js xByName; userId null:
//       none, or not read). The game's own X links (kanban #3331) are kept here, per game key, in x_links - never in the bug bounty's book
//   s2: the bug bounty's Season 2 store (arena-node/src/bounty-season.js openBountySeason) - only a FALLBACK for keys linked there before #3331; read only
//   botXHandles() -> Set of lower-case X handles on the bot list (FAUCET_BOT_X_HANDLES, read on every call)
//   alert(text): the owner's alert hook (off unless configured)
//   lnCheck(address) -> { ok, address } | { ok: false, why }: a player's Lightning address asked at its wallet (opr-lnaddress.mjs checkLnAddress)
// NOTHING IS PAID HERE. The service writes payout lists and their approval records; paying stays a separate step.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { eventRefusal } from '../../arena-node/src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../../arena-node/src/feedback-store.js';
import { encodeRoundPost, levelHashOf } from './opr-chain.mjs';
import { bestPerPlayer, payoutLists, SPLIT } from './opr-payout.mjs';
import { checkLnAddress, lnAddressSyntax, LN_CHECKS_PER_HOUR } from './opr-lnaddress.mjs';
import { runFeatures, nearLogs, deviceOf, scoreRun, topReasons, HOLD_ABOVE } from './opr-botscore.mjs';
import { ipKey } from '../../arena-node/src/faucet.js';
import { readFileSync } from 'node:fs';

/** The X handle as typed (@name, name or an x.com link) -> the bare name, or null when it cannot be one (kanban #3331). */
export function xHandleOf(text) {
  const n = String(text == null ? '' : text).trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(n) ? n : null;
}
export const X_CHECK_GAP_MS = 15000, X_CHECKS_PER_HOUR = 20;
const botListFromEnv = () => { try { const f = process.env.FAUCET_BOT_X_HANDLES; return new Set(f ? readFileSync(f, 'utf8').split('\n').map((l) => l.trim().replace(/^@/, '').toLowerCase()).filter((l) => l && !l.startsWith('#')) : []); } catch { return new Set(); } };

const DAY_MS = 86400000, MIN_MS = 60000;
export const DEFAULTS = Object.freeze({
  firstDay: '2026-11-23', daily: true, entrySats: 0, maxAttempts: 5, submitMs: 10 * MIN_MS, lastCallMs: 5 * MIN_MS, invoiceS: 600,
  verifyGraceMs: 60 * MIN_MS, bountySats: 2500,   // the play bounty in real sats (owner 2026-11-22: 2,500 - 5,000 earlier that day, 10,000 before; it was 2,000) - every round reads it here, none stores its own
  bountyClaimMs: 7 * DAY_MS, alertAfterMs: 15 * MIN_MS, fastSlackMs: 1000, maxSteps: 180 * 60,
  confirmations: 1, publicBases: ['https://testnet-stage.bitcoinarena.io/api/opr'], promoEnd: null, adminSha: '', workerKey: '', showTest: false, ipCrowd: 3,
  testMinutesMost: 24 * 60, logPressesMost: 6000, bodyMost: 256 * 1024, ipAttemptsShare: 2,
});
// FREE ROUNDS (kanban #3273, owner 2026-11-22: "a free round - no testnet sats, but 2,000 real sats for the winner" - since 10,000, #3251): a round made now has
// entry_sats 0. A free run starts at once (no invoice, no lnd), counts as paid (paid_ms = its start), is scored at submit; the round has no pot
// and no pot list - only the bounty list. A round made earlier with entry_sats > 0 keeps the paid path below unchanged
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
  // THE PROMOTION'S END (kanban #3328, owner 2026-11-22: one week from the first daily round - the last one is 2026-11-29, the end 2026-11-30 00:00Z):
  // cfg.promoEnd an ISO time or date (OPR_PROMO_END; null: open-ended). No daily round is made that would end after it; the public round names it
  const promoEndMs = cfg.promoEnd == null || cfg.promoEnd === '' ? null : Date.parse(String(cfg.promoEnd));
  if (promoEndMs !== null && !Number.isFinite(promoEndMs)) throw new Error(`promoEnd is not a time: ${cfg.promoEnd}`);
  const dailyDay = (day) => cfg.daily && day >= cfg.firstDay && (promoEndMs === null || dayStart(day) + DAY_MS <= promoEndMs);
  const now = o.now || (() => Date.now());
  const log = o.log || ((m) => console.log(`${new Date().toISOString()} ${m}`));
  const alert = o.alert || (() => {});
  const { sim, fetchCandles, checkLevel, invoices, chain = null, s2 = null } = o;
  const lnCheck = o.lnCheck || ((a) => checkLnAddress(a));
  const xLookup = o.xLookup || null, botXHandles = o.botXHandles || botListFromEnv;
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
  // THE PLAYER'S LIGHTNING ADDRESS (kanban #3250): ln_address the last one its wallet confirmed, ln_address_ms when, ln_since_ms when the player
  // first had a valid one (never moved by a later change: the bounty's "saved by one hour after the round"); ln_checks: the wallet asks of the last hour
  for (const col of ['ln_address TEXT', 'ln_address_ms INTEGER', 'ln_since_ms INTEGER']) { try { db.exec(`ALTER TABLE players ADD COLUMN ${col}`); } catch { /* there already */ } }
  // THE BOT LIKELIHOOD (kanban #3274): bot_feat a run's own features (opr-botscore.mjs runFeatures), made once at submit; held: a list's held rows
  try { db.exec('ALTER TABLE attempts ADD COLUMN bot_feat TEXT'); } catch { /* there already */ }
  try { db.exec('ALTER TABLE payout_lists ADD COLUMN held TEXT'); } catch { /* there already */ }
  // THE GAME'S OWN X LINKS (kanban #3331, owner 2026-11-22: the game must not be tied to feedback reports): one X account per game key and one game
  // key per X account (user_id UNIQUE: first come, first served - nothing is proven, so an account never moves to another key); linked_ms is when
  // this key took it (the placement rules count from there). x_checks: the lookups asked, for the per-key limit
  db.exec(`CREATE TABLE IF NOT EXISTS x_links (pubkey TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL, linked_ms INTEGER NOT NULL, checked_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS x_checks (player TEXT NOT NULL, at_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS x_checks_by_player ON x_checks (player, at_ms);`);
  db.exec('CREATE TABLE IF NOT EXISTS ln_checks (player TEXT NOT NULL, at_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS ln_checks_by_player ON ln_checks (player, at_ms);');
  // ONE ADDRESS, A FEW PLAYERS' ATTEMPTS (kanban #3283): ip_key the caller's address as a limit counts it (an IPv6 /64 as one, faucet.js ipKey)
  try { db.exec('ALTER TABLE attempts ADD COLUMN ip_key TEXT'); } catch { /* there already */ }
  db.exec('CREATE INDEX IF NOT EXISTS attempts_by_ip_key ON attempts (round, ip_key)');
  // NEAR-IDENTICAL RUNS, FOUND ONCE (kanban #3282): near_rep the first earlier run of the round this run's log is near (nearLogs) - its own id when
  // none - and presses_n its press count; set at submit, so the bot pass reads groups instead of comparing every pair of logs at list time
  for (const col of ['near_rep TEXT', 'presses_n INTEGER']) { try { db.exec(`ALTER TABLE attempts ADD COLUMN ${col}`); } catch { /* there already */ } }
  db.exec('CREATE INDEX IF NOT EXISTS attempts_near ON attempts (round, near_rep, presses_n); CREATE INDEX IF NOT EXISTS attempts_by_player ON attempts (player, created_ms);');
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
    if (cfg.daily && endMs > dayStart(cfg.firstDay) && (promoEndMs === null || startMs < promoEndMs)) {
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
    if (!dailyDay(day) || roundRow(day)) return null;
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
  // PER ADDRESS (kanban #3283): keys are free, so the per-key 5 alone let one address open attempts (and store refused runs) without end. One
  // address opens at most ipAttemptsShare x the round's attempts (2 players' worth: 10 in a daily round); a caller with no address is not counted
  const ipFull = (r, key) => !!key && q(`SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND ip_key = ? AND state != 'expired'`).get(r.id, key).n >= cfg.ipAttemptsShare * r.max_attempts;
  const IP_FULL = 'this address opened all the attempts it may in this round';
  const startedCount = (round) => q('SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND paid_ms IS NOT NULL').get(round).n;   // the pot: paid entries only
  const phaseOf = (r, t = now()) => (t >= r.end_ms || ['closed', 'listed'].includes(r.state) ? 'ended' : r.state !== 'ready' ? (r.state === 'posting' ? 'posting' : 'preparing')
    : t < r.start_ms ? 'soon' : t >= r.end_ms - cfg.lastCallMs ? 'last-call' : 'open');
  // CARRY (kanban #3266): a round takes a carry only from an APPROVED pot list - a waiting list can still be rebuilt to pay it, so its carry
  // is not decided yet. An approved carry goes to the first later daily round whose pot list is not final (none yet, or waiting)
  function carryTarget(fromId) {
    const f = roundRow(fromId);
    const x = f && q(`SELECT r.id FROM rounds r LEFT JOIN payout_lists l ON l.round = r.id AND l.kind = 'pot'
      WHERE r.test = 0 AND r.entry_sats > 0 AND r.state != 'void' AND r.start_ms > ? AND (l.state IS NULL OR l.state = 'waiting') ORDER BY r.start_ms LIMIT 1`).get(f.start_ms);
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
  const isFree = (r) => !(r.entry_sats > 0);
  const potOf = (r) => (isFree(r) ? 0 : r.entry_sats * startedCount(r.id) + carryIn(r));   // a free round has no pot and takes no carry (#3273)

  async function startAttempt(player, { round, ip = null } = {}) {
    const t = now();
    const r = round ? roundRow(round) : currentRound(t);
    if (!r) return { ok: false, why: 'no round is open' };
    if (r.test && !cfg.showTest) return { ok: false, why: 'no round is open' };
    const ph = phaseOf(r, t);
    if (ph === 'last-call') return { ok: false, why: 'no new attempts in the last 5 minutes of a round' };
    if (ph !== 'open') return { ok: false, why: `the round is not open (${ph})` };
    if (usedBy(r.id, player, t) >= r.max_attempts) return { ok: false, why: `all ${r.max_attempts} attempts of this round are used` };
    const ik = ipKey(ip);
    if (ipFull(r, ik)) return { ok: false, why: IP_FULL };
    // THE RUN OPENS AT ONCE (kanban #3265, the owner 2026-11-21: play at once with an empty new wallet): the level, a token and the entry invoice
    // together; the invoice lives exactly as long as the run's 10 minutes, so an entry paid after the deadline is impossible
    const deadline = Math.min(t + cfg.submitMs, r.end_ms);
    const expirySeconds = Math.floor((deadline - t) / 1000);
    if (expirySeconds < 60 || t >= r.end_ms - cfg.lastCallMs) return { ok: false, why: 'no new attempts in the last 5 minutes of a round' };
    if (isFree(r)) {   // FREE (kanban #3273): started and paid at once - no invoice, lnd is never asked
      const id = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('hex');
      q(`INSERT INTO attempts (id, round, player, ip, ip_key, created_ms, started_ms, paid_ms, token, deadline_ms, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')`).run(id, r.id, player, ip, ik, t, t, t, token, deadline);
      q('INSERT INTO players (pubkey, seen_ms) VALUES (?, ?) ON CONFLICT (pubkey) DO UPDATE SET seen_ms = excluded.seen_ms').run(player, t);
      return { ok: true, attempt: id, state: 'started', paid: true, free: true, sats: 0, token, startedMs: t, deadlineMs: deadline, level: levelFor(r) };
    }
    if (!invoices) return { ok: false, why: 'the entry invoice could not be made - try again in a minute' };
    let inv;
    try { inv = await invoices.create({ sats: r.entry_sats, memo: `Orange Pill Run ${r.id} entry`, expirySeconds }); }
    catch (e) { log(`entry invoice not made: ${e.message}`); return { ok: false, why: 'the entry invoice could not be made - try again in a minute' }; }
    // the count again after the wait: two starts at once never make a sixth
    if (usedBy(r.id, player, now()) >= r.max_attempts) return { ok: false, why: `all ${r.max_attempts} attempts of this round are used` };
    if (ipFull(r, ik)) return { ok: false, why: IP_FULL };
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    q(`INSERT INTO attempts (id, round, player, ip, ip_key, invoice, paid_hash, invoice_expires_ms, created_ms, started_ms, token, deadline_ms, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, r.id, player, ip, ik, inv.invoice, inv.hash, t + expirySeconds * 1000, t, t, token, deadline);
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

  // the page's run telemetry (kanban #3274): kept as sent, cut to 2,000 chars - the t object is shortened first so the rest stays readable JSON
  /**
   * PLACE ONE RUN AMONG THE ROUND'S NEAR GROUPS (kanban #3282): its log against the groups' first runs with about as many presses (nearLogs' own
   * length window), the newest NEAR_CANDIDATES_MOST of them - bounded work per submit, never a pass over every pair of the round's runs.
   */
  const NEAR_CANDIDATES_MOST = 200;
  function placeNear(id) {
    const a = q('SELECT id, round, log, near_rep FROM attempts WHERE id = ?').get(id);
    if (!a || a.near_rep || a.log == null) return;
    const lg = J(a.log), n = lg && Array.isArray(lg.presses) ? lg.presses.length : 0;
    let rep = a.id;
    if (n >= 10) {
      const slack = Math.max(1, Math.floor(n * 0.05));
      const cands = q('SELECT id, log FROM attempts WHERE round = ? AND near_rep = id AND id != ? AND presses_n BETWEEN ? AND ? ORDER BY created_ms DESC LIMIT ?')
        .all(a.round, a.id, n - slack, n + slack, NEAR_CANDIDATES_MOST);
      for (const c of cands) if (nearLogs(lg, J(c.log))) { rep = c.id; break; }
    }
    q('UPDATE attempts SET near_rep = ?, presses_n = ? WHERE id = ?').run(rep, n, a.id);
  }
  const clientText = (c) => { const s = JSON.stringify(c && typeof c === 'object' ? c : {}); if (s.length <= 2000) return s;
    const { t, ...rest } = c; const tt = t && typeof t === 'object' ? { src: t.src, jit: t.jit, taps: t.taps, blur: t.blur, hidden: t.hidden, hiddenMs: t.hiddenMs, first: t.first, wd: t.wd, auto: Array.isArray(t.auto) ? t.auto.slice(0, 6) : undefined, dc: t.dc, dpr: t.dpr } : undefined;
    const s2 = JSON.stringify({ ...rest, ua: String(rest.ua || '').slice(0, 160), t: tt }); return s2.length <= 2000 ? s2 : JSON.stringify({ t: tt }); };
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
    // A REFUSED RUN KEEPS ITS LOG ONLY WHEN IT IS A LOG (kanban #3283): a well-formed one (at most logPressesMost presses) stays for the bot pass and
    // the replay; anything else (up to 256 KB of junk each, from free keys) is not stored - the refusal and its reason are
    const reject = (why, extra = {}) => {
      q("UPDATE attempts SET state = 'rejected', why = ?, submitted_ms = ?, log = ?, client = ?, flags = ? WHERE id = ? AND state = ?")
        .run(why, t, extra.keepLog ? JSON.stringify(body.log) : null, clientText(body.client), JSON.stringify(extra.flags || {}), a.id, from);
      if (extra.keepLog) {   // its features and near group now, as a scored run's (kanban #3282: none of it is left for the list time)
        try { q('UPDATE attempts SET bot_feat = ? WHERE id = ? AND bot_feat IS NULL').run(JSON.stringify(runFeatures(sim, levelOf(r), body.log)), a.id); } catch { /* none */ }
        placeNear(a.id);
      }
      log(`attempt ${a.id.slice(0, 8)} of ${a.round} refused: ${why}`);
      return { ok: false, why, closed: true };
    };
    if (t > a.deadline_ms) { if (from === 'started') q("UPDATE attempts SET state = 'timeout', why = 'not submitted in time' WHERE id = ? AND state = 'started'").run(a.id); return { ok: false, why: 'the 10 minutes of this attempt are over', closed: true }; }
    const bad = logRefusal(body.log, { maxSteps: cfg.maxSteps, most: cfg.logPressesMost });
    if (bad) return reject(`malformed log: ${bad}`);
    if (body.log.v !== r.game_version) return reject(`wrong game version: the round plays ${r.game_version}`, { keepLog: true });
    let res;
    try { res = sim.runLog(levelOf(r), body.log, { maxSteps: cfg.maxSteps }); } catch (e) { return reject(`the log does not replay (${String(e.message).slice(0, 80)})`, { keepLog: true }); }
    if (!res || !Number.isSafeInteger(res.steps) || !Number.isFinite(res.total)) return reject('the log does not replay', { keepLog: true });
    const gameMs = (res.steps * 1000) / 60;
    if (t - a.started_ms + cfg.fastSlackMs < gameMs) return reject(`submitted faster than the run's game time (${Math.round(gameMs / 1000)} s)`, { flags: { tooFast: true }, keepLog: true });
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
    let feat = null;
    try { feat = runFeatures(sim, levelOf(r), body.log); } catch (e) { log(`attempt ${a.id.slice(0, 8)}: no bot features (${String(e.message).slice(0, 80)})`); }
    const review = Object.keys(flags).length ? 'pending' : 'none';
    // a run whose entry is not paid yet is kept with its score, waiting: it is placed only once the entry settles before the deadline (#3265)
    const to = from === 'started' ? 'scored' : 'awaiting';
    const done = q(`UPDATE attempts SET state = ?, submitted_ms = ?, log = ?, log_hash = ?, score = ?, flags = ?, client = ?, review = ?, bot_feat = ? WHERE id = ? AND state = ?`)
      .run(to, t, JSON.stringify(body.log), logHash, JSON.stringify(score), JSON.stringify(flags), clientText(body.client), review, feat ? JSON.stringify(feat) : null, a.id, from);
    if (!done.changes) return { ok: false, why: 'that token was used already' };
    placeNear(a.id);
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
  // ONE NAME, ONE PLAYER (kanban #3277, #3280): a chosen name another key holds (any case) is refused, and the default form 'player <8 hex>' is kept
  // for the players without one. A board row names its player by rowKey (a hash of the key; GET /me tells a player its own), never by name
  const nameRefusal = (pk, n) => (/^player [0-9a-f]{8}$/i.test(n) ? "that name is kept for players without one ('player' and 8 hex)"
    : q('SELECT 1 AS x FROM players WHERE lower(name) = lower(?) AND pubkey != ?').get(n, pk) ? 'that name is taken - pick another' : null);
  const rowKeyOf = (pk) => sha(`opr-row|${pk}`).slice(0, 16);
  const dq = (round) => new Set(q('SELECT player FROM disqualified WHERE round = ?').all(round).map((x) => x.player));
  function runsOf(round) {
    const out = dq(round);
    return q("SELECT * FROM attempts WHERE round = ? AND state = 'scored'").all(round).filter((a) => !out.has(a.player)).map((a) => {
      const s = J(a.score, {});
      return { attempt: a.id, player: a.player, total: s.total, timeS: s.timeS, submittedMs: a.submitted_ms, finished: s.finished, clean: s.clean, deaths: s.deaths, flags: J(a.flags, {}), review: a.review };
    });
  }
  /** A player's Lightning address for round r's lists: { address, inTime } - inTime: a valid one saved by the X grace after the round (#3250). */
  const lnOf = (r) => (pk) => { const p = q('SELECT ln_address, ln_since_ms FROM players WHERE pubkey = ?').get(pk);
    return { address: (p && p.ln_address) || null, inTime: !!(p && p.ln_address && p.ln_since_ms != null && p.ln_since_ms <= r.end_ms + cfg.verifyGraceMs) }; };
  const storedLn = (pk) => { const p = q('SELECT ln_address FROM players WHERE pubkey = ?').get(pk); return (p && p.ln_address) || null; };
  /**
   * SAVE A LIGHTNING ADDRESS (kanban #3250, POST /lnaddress): the syntax first (no wallet asked for a typo), then at most LN_CHECKS_PER_HOUR wallet
   * asks per player and hour, then the wallet itself. Kept only when it answered as a Lightning address; the waiting lists are rebuilt with it.
   */
  async function saveLnAddress(player, address) {
    const s = lnAddressSyntax(address);
    if (!s.ok) return { ok: false, code: 400, why: s.why };
    const t = now();
    const n = q('SELECT COUNT(*) AS n, MIN(at_ms) AS first FROM ln_checks WHERE player = ? AND at_ms > ?').get(player, t - 60 * MIN_MS);
    if (n.n >= LN_CHECKS_PER_HOUR) return { ok: false, code: 429, why: `Too many checks - try again in ${Math.max(1, Math.ceil((n.first + 60 * MIN_MS - t) / MIN_MS))} min` };
    q('INSERT INTO ln_checks (player, at_ms) VALUES (?, ?)').run(player, t);
    let c;
    try { c = await lnCheck(s.address); } catch { c = { ok: false, why: 'That wallet did not answer' }; }
    if (!c || !c.ok) { log(`ln address of ${player.slice(0, 8)} not kept: ${c && c.why}`); return { ok: false, code: 400, why: String((c && c.why) || 'That wallet did not answer').slice(0, 80) }; }
    const at = now();
    q(`INSERT INTO players (pubkey, ln_address, ln_address_ms, ln_since_ms, seen_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (pubkey) DO UPDATE SET ln_address = excluded.ln_address, ln_address_ms = excluded.ln_address_ms, ln_since_ms = COALESCE(players.ln_since_ms, excluded.ln_since_ms)`)
      .run(player, s.address, at, at, at);
    log(`ln address of ${player.slice(0, 8)} kept (${s.domain})`);
    for (const x of q("SELECT DISTINCT l.round FROM payout_lists l JOIN rounds r ON r.id = l.round WHERE l.state = 'waiting' AND r.state = 'listed'").all()) refreshLists(x.round);
    return { ok: true, lnAddress: s.address };
  }
  function boardOf(round) { return bestPerPlayer(runsOf(round)).map((b) => ({ ...b, name: nameOf(b.player) })); }
  /**
   * THE BOT LIKELIHOOD OF A ROUND (kanban #3274), admin and lists only: { runs: Map attempt -> { score, reasons, top }, players: Map player ->
   * { score, top, attempt } } - a player's is their most bot-like scored run. Across runs: near-identical inputs of other players and of the
   * player's own runs, players per address and per device, new players arriving together, a known bot X account.
   */
  // LINEAR IN THE ROUND'S RUNS (kanban #3282): the near groups were found at submit (placeNear; a run from before that is placed here once), the
  // first-seen times come from one grouped read, new players together are looked for among the players of the same address only, X read once a player
  function botsOf(round) {
    round = String(round);
    for (const x of q("SELECT id FROM attempts WHERE round = ? AND state IN ('scored', 'rejected') AND log IS NOT NULL AND near_rep IS NULL ORDER BY created_ms").all(round)) placeNear(x.id);
    const rows = q("SELECT id, player, ip, client, flags, bot_feat, state, created_ms, near_rep FROM attempts WHERE round = ? AND state IN ('scored', 'rejected') AND log IS NOT NULL ORDER BY created_ms").all(round);
    const rr = roundRow(round);
    const ipPlayers = new Map(), devPlayers = new Map(), devOf = new Map(), groups = new Map();
    const addTo = (m, k, p) => { if (!k) return; const s = m.get(k) || new Set(); s.add(p); m.set(k, s); };
    for (const a of rows) {
      const d = deviceOf(J(a.client, {})); devOf.set(a.id, d); addTo(ipPlayers, a.ip, a.player); addTo(devPlayers, d, a.player);
      const g = groups.get(a.near_rep || a.id) || new Map(); g.set(a.player, (g.get(a.player) || 0) + 1); groups.set(a.near_rep || a.id, g);
    }
    const firsts = new Map(q('SELECT player, MIN(created_ms) AS m FROM attempts WHERE player IN (SELECT DISTINCT player FROM attempts WHERE round = ?) GROUP BY player').all(round).map((x) => [x.player, x.m]));
    const xs = new Map(), xFor = (p) => { if (!xs.has(p)) xs.set(p, xOf(p)); return xs.get(p); };
    const runs = new Map(), players = new Map();
    for (const a of rows) {
      let feat = J(a.bot_feat);
      if (!feat && rr) { try { feat = runFeatures(sim, levelOf(rr), J(q('SELECT log FROM attempts WHERE id = ?').get(a.id).log)); q('UPDATE attempts SET bot_feat = ? WHERE id = ? AND bot_feat IS NULL').run(JSON.stringify(feat), a.id); } catch { feat = {}; } }
      const g = groups.get(a.near_rep || a.id);
      const othersN = g.size - (g.has(a.player) ? 1 : 0), repeatOwn = (g.get(a.player) || 0) >= 2;
      const f0 = firsts.get(a.player);
      let near = 0;   // new players together from one address
      if (a.ip && f0 != null) for (const p of ipPlayers.get(a.ip) || []) { const m = firsts.get(p); if (p !== a.player && m != null && Math.abs(m - f0) <= 10 * MIN_MS) near++; }
      const x = xFor(a.player);
      const s = scoreRun({ feat: feat || {}, flags: J(a.flags, {}), client: J(a.client, {}), cross: { nearOther: othersN, repeatOwn,
        ipPlayers: a.ip ? (ipPlayers.get(a.ip) || new Set()).size : 0, devicePlayers: devOf.get(a.id) ? devPlayers.get(devOf.get(a.id)).size : 0,
        ageMs: f0 == null ? null : a.created_ms - f0, newNearby: near ? near + 1 : 0, botX: x.why === 'a known bot account' } });
      const v = { score: s.score, top: topReasons(s), reasons: s.reasons };
      runs.set(a.id, v);
      const pl = players.get(a.player);
      if (a.state === 'scored' && (!pl || v.score > pl.score)) players.set(a.player, { score: v.score, top: v.top, attempt: a.id });
    }
    return { runs, players };
  }
  /**
   * PLACED (kanban #3245, #3250, #3331): an X account this game key linked in the game's own x_links (found on X at save time), or - for a key
   * linked before #3331 - its Season 2 link verified by the bug bounty; not on the bot list.
   * TYPED OR PROVEN, BOTH PLACE (kanban #3279, #3285; owner 2026-11-22 ~12:45Z: "Zu kompliziert, mach das weg"): an X account linked in the
   * Season 2 book the normal way places the player - a handle typed in the social form (proof 'name', claimName) as well as a posted link code
   * (proof 'code', redeem). The proof kind rides along as x.proof ('typed' | 'code') so the admin page and every list row show it at the owner's
   * sign-off; nothing is refused for it.
   * BY THE HOUR AFTER THE ROUND (kanban #3278, #3286; #3250: "verify until 1 hour after the round ends"): with round r given, a link made after
   * r.end_ms + verifyGraceMs does not place the player in r - a later list rebuild (any POST /lnaddress) cannot bring a late link in.
   * LINKED BEFORE THE FIRST RUN (kanban #3281, #3288): the 5 attempts are counted per key, the bounty is paid per X account, and keys are free -
   * one person played 5 runs on each of N fresh keys and linked the one X account after the round to the best of them. A key is placed in r
   * only when its X link was made before its first attempt of r: every run that can win was made by the key while it held the account,
   * and one X account is on one key at a time (redeem refuses an account a code linked to another key), so one X account stands behind at most
   * one key's attempts in a round. A key that links later is placed from its next round on.
   */
  const firstRunOf = (round, pk) => q("SELECT MIN(created_ms) AS m FROM attempts WHERE round = ? AND player = ? AND state != 'expired'").get(round, pk).m;
  const isBotX = (name) => { const b = botXHandles(); return !!name && b.has(String(name).replace(/^@/, '').toLowerCase()); };
  const xLinkOf = (pk) => q('SELECT * FROM x_links WHERE pubkey = ?').get(String(pk)) || null;
  // THE GAME'S OWN LINK FIRST (kanban #3331): the existence check at save time is its verification - no follow, no member read. A key with no game
  // link falls back to its Season 2 link made before #3331 (the old rules, unchanged), unless another game key now holds that X account here
  function xOf(pk, r = null) {
    const g = xLinkOf(pk);
    let l = null, flags = {}, viaS2 = false;
    if (g) l = { userId: g.user_id, username: g.username, linkedMs: g.linked_ms, proof: 'game' };
    else if (s2) {
      try { l = s2.links(pk).find((x) => x.platform === 'x') || null; flags = s2.flagsOf(pk) || {}; } catch (e) { return { placed: false, x: null, why: `X not read (${e.message})` }; }
      if (l) { viaS2 = true; const held = q('SELECT pubkey FROM x_links WHERE user_id = ?').get(String(l.userId)); if (held && held.pubkey !== pk) l = null; }
    }
    if (!l) return { placed: false, x: null, why: 'no X account linked' };
    const x = { userId: String(l.userId), username: l.username || null, proof: l.proof === 'game' ? 'game' : l.proof === 'code' ? 'code' : 'typed' };   // shown at sign-off (#3279)
    if (flags.bot || isBotX(l.username)) return { placed: false, x, why: 'a known bot account' };
    if (viaS2 && l.member !== true) return { placed: false, x, why: 'the X account is not verified yet' };
    if (r && !(Number(l.linkedMs) <= r.end_ms + cfg.verifyGraceMs)) return { placed: false, x, why: 'the X account was linked more than 1 hour after the round ended' };
    if (r) {
      const first = firstRunOf(r.id, pk);
      if (first != null && !(Number(l.linkedMs) <= first)) return { placed: false, x, why: 'the X account was linked after your first run of this round - it counts from the next round' };
      // verified (a member read) after the link and by the hour after the round - a read days later does not rebuild a waiting list either (#3278)
      if (viaS2 && !s2.memberRead(pk, 'x', { userId: l.userId, fromMs: l.linkedMs, toMs: r.end_ms + cfg.verifyGraceMs })) return { placed: false, x, why: 'the X account was not verified by 1 hour after the round ended' };
    }
    return { placed: true, x, why: null };
  }
  /**
   * SAVE AN X HANDLE (kanban #3331, POST /x { x }): the name looked up on X (it must exist; following is not asked), then kept for this game key.
   * Refused when another game key holds that X account. The same account again: saved, linked_ms unchanged. Another account: replaces this key's
   * link with a new linked_ms (the old one is free again; the new one counts from the key's next round it has not played yet).
   */
  async function saveX(player, typed) {
    const name = xHandleOf(typed);
    if (!name) return { ok: false, code: 400, why: 'Not an X username' };
    if (!xLookup) return { ok: false, code: 503, why: 'X cannot be checked here' };
    const t = now();
    const last = q('SELECT MAX(at_ms) AS m, COUNT(*) AS n FROM x_checks WHERE player = ? AND at_ms > ?').get(player, t - 60 * MIN_MS);
    if (last.m != null && t - last.m < X_CHECK_GAP_MS) return { ok: false, code: 429, why: `One check every ${X_CHECK_GAP_MS / 1000} seconds - try again in a moment` };
    if (last.n >= X_CHECKS_PER_HOUR) return { ok: false, code: 429, why: 'Too many checks - try again in an hour' };
    q('INSERT INTO x_checks (player, at_ms) VALUES (?, ?)').run(player, t);
    let a;
    try { a = await xLookup(name); } catch (e) { a = { userId: null, why: String(e && e.message || e) }; }
    if (a && !a.userId && /no such X account/i.test(String(a.why || ''))) return { ok: false, code: 404, why: 'no such X account', username: name };
    if (!a || !a.userId) { log(`x check for ${player.slice(0, 8)} not answered: ${a && a.why}`); return { ok: false, code: 503, why: 'X could not be checked right now - try again in a minute' }; }
    const userId = String(a.userId), username = String(a.username || name).replace(/^@/, '');
    const mine = xLinkOf(player);
    if (mine && mine.user_id === userId) { q('UPDATE x_links SET username = ?, checked_ms = ? WHERE pubkey = ?').run(username, now(), player); return { ok: true, x: { username } }; }
    const held = q('SELECT pubkey FROM x_links WHERE user_id = ?').get(userId);
    if (held && held.pubkey !== player) return { ok: false, code: 409, why: 'this X account is already used by another player', username };
    const at = now();
    try {
      q(`INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (pubkey) DO UPDATE SET user_id = excluded.user_id, username = excluded.username, linked_ms = excluded.linked_ms, checked_ms = excluded.checked_ms`).run(player, userId, username, at, at);
    } catch (e) { if (/UNIQUE/i.test(e.message)) return { ok: false, code: 409, why: 'this X account is already used by another player', username }; throw e; }
    log(`x @${username} linked to ${player.slice(0, 8)}${mine ? ` (was @${mine.username})` : ''}`);
    for (const x of q("SELECT DISTINCT l.round FROM payout_lists l JOIN rounds r ON r.id = l.round WHERE l.state = 'waiting' AND r.state = 'listed'").all()) refreshLists(x.round);
    return { ok: true, x: { username } };
  }
  function publicBoard(round, viewer = null) {
    const r = roundRow(round);
    const ended = now() >= r.end_ms;
    const used = new Map(q('SELECT player, COUNT(*) AS n FROM attempts WHERE round = ? AND paid_ms IS NOT NULL GROUP BY player').all(round).map((x) => [x.player, x.n]));
    return boardOf(round).map((b) => ({ rank: b.rank, name: b.name, key: rowKeyOf(b.player), player: b.player, score: b.total, timeS: b.timeS, attempts: used.get(b.player) || 0,
      placed: xOf(b.player, r).placed, replay: (ended && b.rank <= 10) || b.player === viewer ? `/replay/${b.attempt}` : null }));
  }

  // ---------- payout lists ----------
  function buildLists(r) {
    const board = boardOf(r.id);
    const bots = botsOf(r.id);
    const botOf = (p) => { const b = bots.players.get(p); return b ? { score: b.score, reasons: b.top } : null; };
    const rejected = (kind) => new Set(q('SELECT player FROM row_rejects WHERE round = ? AND kind = ?').all(r.id, kind).map((x) => x.player));
    const make = (kind) => {
      const rj = rejected(kind);
      // A LIKELY BOT IS HELD (kanban #3274): above HOLD_ABOVE the row waits for review - the admin clears the run (POST /admin/review) to lift it
      return payoutLists({ board, potSats: potOf(r), placedOf: (p) => xOf(p, r), bountySats: cfg.bountySats, test: !!r.test, lnOf: lnOf(r), botOf,
        held: (p) => { const b = board.find((x) => x.player === p), bt = bots.players.get(p);
          return rj.has(p) ? 'row rejected' : bt && bt.score > HOLD_ABOVE && !(b && b.review === 'cleared') ? `bot likelihood ${bt.score} - held for review`
            : b && b.review === 'pending' ? 'under review' : null; } });
    };
    return { pot: isFree(r) ? null : make('pot').pot, bounty: make('bounty').bounty };   // a free round: the bounty list only (#3273)
  }
  function writeList(r, kind, list, t) {
    if (!list) return;
    const had = q('SELECT state FROM payout_lists WHERE round = ? AND kind = ?').get(r.id, kind);
    if (had && had.state !== 'waiting') return;   // an approved or rejected list is never rewritten
    const sats = list.rows.reduce((a, x) => a + x.sats, 0);
    q(`INSERT INTO payout_lists (round, kind, rows, sats, carry_sats, state, made_ms, held) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)
       ON CONFLICT (round, kind) DO UPDATE SET rows = excluded.rows, sats = excluded.sats, carry_sats = excluded.carry_sats, made_ms = excluded.made_ms, held = excluded.held`)
      .run(r.id, kind, JSON.stringify(list.rows), sats, list.carrySats || 0, t, JSON.stringify(list.held || []));
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
    const parts = [l.pot ? `pot ${l.pot.potSats} sat: ${rows(l.pot)}` : 'free round, no pot', l.bounty ? `bounty: ${rows(l.bounty)}` : null].filter(Boolean);
    alert(`Orange Pill Run ${r.id}${r.test ? ' (test)' : ''}: payout lists wait for sign-off - ${parts.join('; ')}`);
    log(`round ${r.id}: payout lists written (waiting for sign-off)`);
  }
  // THE VERSION A SIGN-OFF NAMES (kanban #3287): a hash of what the owner reviews - rows, held rows, sats, carry. A waiting list is rebuilt by
  // any player's POST /lnaddress, a review, a row reject, a late entry; an approve names the version it was shown and is refused for another
  const listVersion = (x) => sha(JSON.stringify([J(x.rows, []), J(x.held, []), x.sats, x.carry_sats])).slice(0, 16);
  const listRow = (x) => (x ? { round: x.round, kind: x.kind, rows: J(x.rows, []), sats: x.sats, carrySats: x.carry_sats, state: x.state, by: x.by, atMs: x.at_ms, why: x.why, madeMs: x.made_ms, held: J(x.held, []), version: listVersion(x) } : null);
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
  function decideList({ round, kind, action, by, why = null, version = null } = {}) {
    const l = q('SELECT * FROM payout_lists WHERE round = ? AND kind = ?').get(String(round), String(kind));
    if (!l) return { ok: false, why: 'no such list' };
    if (!['approve', 'reject'].includes(action)) return { ok: false, why: 'approve or reject' };
    if (!by || !String(by).trim()) return { ok: false, why: 'who signs off (by)' };
    if (l.state !== 'waiting') return { ok: false, why: `the list is ${l.state} already` };
    if (action === 'approve' && String(version || '') !== listVersion(l)) return { ok: false, code: 409, why: version ? 'the list changed since you opened it - reload it and review it again' : 'name the list version you reviewed (version)', version: listVersion(l) };
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
    .map((l) => ({ ...l, rows: l.rows.map((w) => (w.lnAddress ? w : { ...w, lnAddress: storedLn(w.player) })), approval: q("SELECT by, at_ms AS atMs FROM approvals WHERE round = ? AND kind = ? AND action = 'approved' ORDER BY n DESC LIMIT 1").get(l.round, l.kind) || null }))
    .filter((l) => l.approval && l.approval.by);
  }
  function claimBounty(player, { round, lnAddress } = {}) {
    const r = roundRow(round);
    if (!r || r.test) return { ok: false, why: 'no bounty in that round' };
    const l = q("SELECT * FROM payout_lists WHERE round = ? AND kind = 'bounty'").get(r.id);
    const row = l && J(l.rows, [])[0];
    if (!row || row.player !== player) return { ok: false, why: 'the bounty of that round is not yours' };
    if (now() > r.end_ms + cfg.bountyClaimMs) return { ok: false, why: 'the bounty expired (7 days after the round)' };
    // THE CLAIM CONFIRMS, IT ADDS NO ADDRESS (kanban #3250, owner 2026-11-22): the bounty went to a player with a valid address saved in time; the
    // claim pays to that stored address (the default) - another one is first saved and checked at POST /lnaddress
    const stored = storedLn(player);
    if (!stored) return { ok: false, why: 'no Lightning address saved - save one first' };
    if (lnAddress != null && String(lnAddress).trim() && String(lnAddress).trim().toLowerCase() !== stored) return { ok: false, why: 'that is not your saved Lightning address - save it first' };
    q('INSERT OR REPLACE INTO bounty_claims (round, player, ln_address, at_ms) VALUES (?, ?, ?, ?)').run(r.id, player, stored, now());
    return { ok: true, lnAddress: stored };
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
        if (dailyDay(d) && now() >= s + cfg.alertAfterMs && !roundRow(d) && !alertedDays.has(d)) { alertedDays.add(d); alert(`Orange Pill Run ${d}: no daily round by ${new Date(s + cfg.alertAfterMs).toISOString().slice(11, 16)}Z`); }
      }
      for (const a of q(`SELECT * FROM attempts WHERE state IN ('invoiced', 'pending', 'awaiting') OR (state = 'rejected' AND paid_ms IS NULL AND paid_hash IS NOT NULL AND deadline_ms > ?)
          ORDER BY created_ms LIMIT 100`).all(now() - 60000)) await settle(a);
      q("UPDATE attempts SET state = 'timeout', why = 'not submitted in time' WHERE state = 'started' AND deadline_ms < ?").run(now());
      for (const r of q(`SELECT * FROM rounds WHERE ${LIVE} AND end_ms <= ?`).all(now())) close(r, now());
      for (const r of q("SELECT * FROM rounds WHERE state = 'closed' AND end_ms + ? <= ?").all(cfg.verifyGraceMs, now())) makeLists(r, now());
      q('DELETE FROM auth_seen WHERE at_ms < ?').run(now() - 5 * MIN_MS);
      q('DELETE FROM ln_checks WHERE at_ms < ?').run(now() - 60 * MIN_MS);
    } finally { ticking = false; }
  }

  function publicRound(r, t = now()) {
    if (!r) return null;
    const board = boardOf(r.id), best = board[0];
    return { id: r.id, number: r.num, test: !!r.test, chartDay: r.chart_day, startMs: r.start_ms, endMs: r.end_ms, phase: phaseOf(r, t), lastCallMs: r.end_ms - cfg.lastCallMs,
      entrySats: r.entry_sats, free: isFree(r), maxAttempts: r.max_attempts, split: [...SPLIT], potSats: potOf(r), bountySats: r.test ? 0 : cfg.bountySats,
      gameVersion: r.game_version, levelHash: r.level_hash, players: board.length,
      post: { txid: r.post_txid, height: r.post_height, confirmed: r.state !== 'waiting' && r.state !== 'posting' && (!!r.post_height || !chain) },
      best: best ? { score: best.total, timeS: best.timeS, name: best.name } : null,
      promo: promoEndMs === null ? null : { firstDay: cfg.firstDay, endMs: promoEndMs } };
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
  // THE ADMIN DOOR (kanban #3284, the faucet's #3263 ported): a caller is the Worker-named address (x-arena-ip under the Worker's key) or, on this
  // host, the socket's - each by ipKey (an IPv6 /64 is one caller); the all-callers count locks only callers that sent a wrong code themselves, so
  // strangers never lock out the owner. A request that came in through a proxy without the Worker's key (the public funnel path /opr reaches
  // 127.0.0.1:18877 with X-Forwarded-For) is no admin caller at all: refused before any count, so it cannot lock the local 127.0.0.1 caller
  const proxied = (req) => !fromWorker(req) && ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'tailscale-funnel-request'].some((h) => req.headers[h] != null);
  function adminGate(req, ip) {
    if (proxied(req)) return [403, 'the admin door is open through the site or on this host only'];
    const who = `admin:${ipKey(ip) || 'unnamed'}`, t = now();
    for (const [k, v] of fails) if (t - v.since > ADMIN_TRY_WINDOW_MS) fails.delete(k);
    const mine = fails.get(who), all = fails.get('admin:*');
    if ((mine && mine.n >= ADMIN_TRIES_PER_CALLER) || (all && all.n >= ADMIN_TRIES_ALL && mine && mine.n > 0)) return [429, 'too many wrong admin codes - try again later'];
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
          const bots = botsOf(String(round));   // kanban #3274: each run's bot likelihood and the player's, with the top 3 reasons
          return send(200, { ok: true, runs: rows.map((a) => ({ attempt: a.id, player: a.player, name: nameOf(a.player), state: a.state, why: a.why, score: J(a.score), flags: J(a.flags, {}),
            bot: bots.runs.has(a.id) ? { score: bots.runs.get(a.id).score, reasons: bots.runs.get(a.id).top } : null,
            playerBot: bots.players.has(a.player) ? { score: bots.players.get(a.player).score, reasons: bots.players.get(a.player).top } : null,
            review: a.review, ip: a.ip, startedMs: a.started_ms, submittedMs: a.submitted_ms, client: J(a.client), x: xOf(a.player), disqualified: out.has(a.player), replay: `/replay/${a.id}` })),
            players: [...bots.players].filter(([p]) => !player || p === player).map(([p, b]) => ({ player: p, name: nameOf(p), bot: { score: b.score, reasons: b.top }, attempt: b.attempt })).sort((x, y) => y.bot.score - x.bot.score),
            holdAbove: HOLD_ABOVE, disqualified: q('SELECT * FROM disqualified WHERE round = ?').all(String(round)) });
        }
        if (req.method === 'GET' && path === '/admin/lists') return send(200, { ok: true, lists: listsOf(String(url.searchParams.get('round'))), approvals: q('SELECT * FROM approvals WHERE round = ? ORDER BY n').all(String(url.searchParams.get('round'))), claim: q('SELECT * FROM bounty_claims WHERE round = ?').get(String(url.searchParams.get('round'))) || null });
        if (req.method === 'GET' && path === '/admin/payable') { try { return send(200, { ok: true, lists: payable() }); } catch (e) { alert(`Orange Pill Run: payable refused - ${e.message}`); return send(409, { ok: false, why: e.message }); } }
        if (req.method === 'POST' && path === '/admin/disqualify') { const r = disqualify({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/review') { const r = review({ ...body, by }); return send(r.ok ? 200 : 400, r); }
        if (req.method === 'POST' && path === '/admin/list') { const { code, ...r } = decideList({ ...body, by }); return send(r.ok ? 200 : code || 400, r); }
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
        const x = xOf(me, r);
        const mine = r ? q('SELECT * FROM attempts WHERE round = ? AND player = ? ORDER BY created_ms').all(r.id, me) : [];
        return send(200, { ok: true, pubkey: me, name: nameOf(me), rowKey: rowKeyOf(me), lnAddress: storedLn(me), x: x.x ? { username: x.x.username } : null, placed: x.placed, placedWhy: x.placed ? null : x.why,
          round: r ? r.id : null, used: r ? usedBy(r.id, me, now()) : 0, maxAttempts: r ? r.max_attempts : cfg.maxAttempts,
          attempts: mine.map((a) => ({ attempt: a.id, state: a.state === 'pending' || a.state === 'awaiting' ? 'pending-entry' : a.state === 'unpaid' ? 'entry-not-paid' : a.state,
            paid: a.paid_ms != null, why: a.why, score: J(a.score), startedMs: a.started_ms })) });
      }
      if (req.method === 'POST' && path === '/name') {
        const n = String(body.name || '').trim();
        if (!/^[A-Za-z0-9 _.-]{2,20}$/.test(n)) return send(400, { ok: false, why: 'a name is 2 to 20 letters, digits, space, _ . -' });
        const taken = nameRefusal(me, n);
        if (taken) return send(409, { ok: false, why: taken });
        q('INSERT INTO players (pubkey, name, seen_ms) VALUES (?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name').run(me, n, now());
        return send(200, { ok: true, name: n });
      }
      if (req.method === 'POST' && path === '/x') { const r = await saveX(me, body.x); const { code, ...out } = r; return send(r.ok ? 200 : code || 400, out); }
      if (req.method === 'POST' && path === '/lnaddress') { const r = await saveLnAddress(me, body.address); const { code, ...out } = r; return send(r.ok ? 200 : code || 400, out); }
      if (req.method === 'POST' && path === '/attempt') { const r = await startAttempt(me, { round: body.round, ip }); return send(r.ok ? 200 : 409, r); }
      if (req.method === 'POST' && path === '/attempt/check') { const r = await checkAttempt(me, body.attempt); return send(r.ok ? 200 : 404, r); }
      if (req.method === 'POST' && path === '/submit') { const r = await submitChecked(me, body, { ip }); return send(r.ok ? 200 : 409, r); }
      if (req.method === 'POST' && path === '/claim') { const r = claimBounty(me, body); return send(r.ok ? 200 : 409, r); }
      return send(404, { ok: false, why: 'no such route' });
    } catch (e) { log(`request failed: ${e.stack || e.message}`); return send(500, { ok: false, why: 'the round service failed on that' }); }
  }

  return { db, cfg, tick, handle, testRound, ensureDaily, startAttempt, checkAttempt, submit, submitChecked, settle, boardOf, publicBoard, publicRound, currentRound, roundRow: (id) => roundRow(id),
    potOf: (id) => potOf(roundRow(id)), listsOf, decideList, rejectRow, disqualify, review, payable, claimBounty, saveLnAddress, saveX, xOf, postFields: (id) => postFields(roundRow(id)), close: () => db.close() };
}
