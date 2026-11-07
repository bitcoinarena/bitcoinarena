// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYER FEEDBACK, KEPT FOR REVIEW (kanban #1342, slice 1). A report is a Nostr event the player's own key signs, so nobody files one in another
// player's name and a reward can only ever go to the key that wrote it. The faucet keeps every report in one SQLite file with a state a human moves:
// new -> accepted | rejected (with a reason the player sees) | duplicate (of an earlier report); accepted -> paid | rejected. Nothing here pays and
// nothing moves on its own. "My feedback" is asked with a NIP-98 HTTP-auth event by the same key: a report's reward link is a bearer secret, so the
// list is never read by its pubkey alone.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { eventId, eventRefusal } from './nostr-relay.js';

/** The report's kind: ephemeral (20000-29999), so no relay keeps it - it goes to the faucet only. */
export const FEEDBACK_KIND = 27842;
/** NIP-98 HTTP auth. */
export const HTTP_AUTH_KIND = 27235;
export const FEEDBACK_TYPES = Object.freeze(['bug', 'confusing', 'idea']);
export const STATES = Object.freeze({ NEW: 'new', ACCEPTED: 'accepted', REJECTED: 'rejected', DUPLICATE: 'duplicate', PAID: 'paid' });
const NEXT = Object.freeze({ new: ['accepted', 'rejected', 'duplicate'], accepted: ['paid', 'rejected'], rejected: [], duplicate: [], paid: [] });
export const TEXT_MOST = 4000;
// THE REWARD RULES (kanban #1342 section 2): settings the owner can change; testnet sats in phase 1
export const REWARD_DEFAULTS = Object.freeze({ perKeyPerWeek: 3, weeklyBudgetSats: 50000, mostSats: 20000, leastSats: 100 });
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const REPORT_AGE_MOST_S = 24 * 3600;     // a report signed more than a day ago is not taken (a replayed one)
export const AUTH_AGE_MOST_S = 60;

// THE SAME SCRUB AS THE CHAT POST (faucet.js feedbackDecide): an nsec, a 64-hex secret or a seed phrase never stays in a kept report
const scrubKeys = (t) => String(t).replace(/\b(nsec|ncryptsec)1[0-9a-z]{20,}\b/gi, '[removed]').replace(/\b[0-9a-f]{64}\b/gi, '[removed]').replace(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, '[removed]');
const tag = (e, k) => { const t = e.tags.find((x) => x[0] === k); return t ? String(t[1] ?? '') : ''; };
const said = (x, re) => (re.test(String(x || '')) ? String(x) : '');

export function openFeedbackStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, type TEXT NOT NULL, signed_at INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      happened TEXT NOT NULL, expected TEXT NOT NULL, game TEXT, round TEXT, build TEXT, event TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'new', reason TEXT, duplicate_of TEXT, severity TEXT, amount_sats INTEGER, ticket TEXT, changed_ms INTEGER);
    CREATE INDEX IF NOT EXISTS reports_by_key ON reports (pubkey, received_ms);
    CREATE TABLE IF NOT EXISTS report_moves (id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, at_ms INTEGER NOT NULL, by TEXT, note TEXT);
    CREATE TABLE IF NOT EXISTS rewards (k1 TEXT PRIMARY KEY, report TEXT NOT NULL UNIQUE, pubkey TEXT NOT NULL, amount_sats INTEGER NOT NULL, network TEXT NOT NULL,
      created_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', invoice TEXT, payment_hash TEXT, tried_ms INTEGER, paid_ms INTEGER, why TEXT);`);
  const get = db.prepare('SELECT * FROM reports WHERE id = ?');
  const row = (r) => (r ? { id: r.id, pubkey: r.pubkey, type: r.type, signedAt: r.signed_at, receivedMs: r.received_ms, happened: r.happened, expected: r.expected,
    game: r.game || null, round: r.round || null, build: r.build || null, state: r.state, reason: r.reason || null, duplicateOf: r.duplicate_of || null,
    severity: r.severity || null, amountSats: r.amount_sats ?? null, ticket: r.ticket || null, changedMs: r.changed_ms ?? null } : null);

  /**
   * A REPORT IN: the signed event, checked as a relay checks one (id, signature), of the report kind, signed within a day. Kept once per event id
   * (a second post of the same event answers the first). Answers { ok, id, kept } or { ok: false, why }.
   */
  function take(e, { nowMs = Date.now() } = {}) {
    const nowS = Math.floor(nowMs / 1000);
    const refused = eventRefusal(e, { kinds: [FEEDBACK_KIND], nowS });
    if (refused) return { ok: false, why: refused.startsWith('blocked:') ? 'that is not a feedback report' : refused };
    if (e.created_at < nowS - REPORT_AGE_MOST_S) return { ok: false, why: 'that report was signed more than a day ago' };
    const type = tag(e, 't');
    if (!FEEDBACK_TYPES.includes(type)) return { ok: false, why: `a report is one of ${FEEDBACK_TYPES.join(', ')}` };
    let body;
    try { body = JSON.parse(e.content); } catch { return { ok: false, why: 'a report\'s content is { happened, expected }' }; }
    const happened = scrubKeys(String((body && body.happened) || '').trim()).slice(0, TEXT_MOST);
    const expected = scrubKeys(String((body && body.expected) || '').trim()).slice(0, TEXT_MOST);
    if (happened.length < 3) return { ok: false, why: 'say what happened' };
    if (get.get(e.id)) return { ok: true, id: e.id, kept: false };
    db.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, game, round, build, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, e.pubkey, type, e.created_at, nowMs, happened, expected, said(tag(e, 'game'), /^[a-z0-9-]{1,48}$/) || null,
        said(tag(e, 'round'), /^[0-9a-f]{8,64}$/) || null, said(tag(e, 'build'), /^[0-9a-zA-Z. -]{1,24}$/) || null, JSON.stringify(e));
    return { ok: true, id: e.id, kept: true };
  }

  /**
   * WHO ASKS (NIP-98): a kind 27235 event signed within a minute, naming this exact URL and method. Answers the pubkey, or { why }.
   */
  function authOf(e, { url, method = 'GET', nowMs = Date.now() } = {}) {
    const nowS = Math.floor(nowMs / 1000);
    const refused = eventRefusal(e, { kinds: [HTTP_AUTH_KIND], nowS });
    if (refused) return { ok: false, why: refused.startsWith('blocked:') ? 'that is not a sign-in (NIP-98)' : refused };
    if (Math.abs(nowS - e.created_at) > AUTH_AGE_MOST_S) return { ok: false, why: 'that sign-in is older than a minute' };
    if (tag(e, 'u') !== url || tag(e, 'method').toUpperCase() !== String(method).toUpperCase()) return { ok: false, why: 'that sign-in names another address or method' };
    return { ok: true, pubkey: e.pubkey };
  }

  /** "MY FEEDBACK": the signed-in key's own reports, newest first. */
  function mine(authEvent, opts) {
    const who = authOf(authEvent, opts);
    if (!who.ok) return who;
    return { ok: true, pubkey: who.pubkey, reports: db.prepare('SELECT * FROM reports WHERE pubkey = ? ORDER BY received_ms DESC').all(who.pubkey).map(row) };
  }

  /**
   * A STATE MOVE, BY A HUMAN (the admin, slice 4): only the moves the table allows; a rejection needs its reason, a duplicate the report it repeats
   * (an earlier one, not itself, not one that is a duplicate in turn). Every move is logged with who made it.
   */
  function move(id, to, { reason = null, duplicateOf = null, by = null, nowMs = Date.now() } = {}) {
    const r = get.get(String(id));
    if (!r) return { ok: false, why: 'no such report' };
    if (!(NEXT[r.state] || []).includes(to)) return { ok: false, why: `a ${r.state} report does not become ${to}` };
    if (to === STATES.ACCEPTED) return { ok: false, why: 'a report is accepted by approve(), with its amount and the reward rules' };
    if (to === STATES.REJECTED && !(reason && String(reason).trim().length >= 3)) return { ok: false, why: 'a rejection says why: the player reads it' };
    if (to === STATES.DUPLICATE) {
      const of = duplicateOf ? get.get(String(duplicateOf)) : null;
      if (!of || of.id === r.id) return { ok: false, why: 'a duplicate names the earlier report it repeats' };
      if (of.state === STATES.DUPLICATE) return { ok: false, why: 'name the first report, not another duplicate' };
      if (of.received_ms > r.received_ms) return { ok: false, why: 'the report it repeats came later: the first report keeps its place' };
    }
    db.prepare('UPDATE reports SET state = ?, reason = ?, duplicate_of = ?, changed_ms = ? WHERE id = ? AND state = ?')
      .run(to, to === STATES.REJECTED ? String(reason).trim().slice(0, 500) : r.reason, to === STATES.DUPLICATE ? String(duplicateOf) : r.duplicate_of, nowMs, r.id, r.state);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, to, nowMs, by, reason || duplicateOf || null);
    return { ok: true, report: row(get.get(r.id)) };
  }

  /**
   * APPROVE FOR MONEY (kanban #1342 section 2): only a new report, by a human, with an amount - and only when every rule holds:
   *   a real player   `played(pubkey)` says the key finished a round (the network season's rows, networkPlayers below)
   *   not ours        the key is not in `excluded` (team, admin and bot keys)
   *   not a duplicate a duplicate is never new; the first report of a bug keeps its place
   *   limits          at most `perKeyPerWeek` approvals per key in 7 days, and the week's approved sum within `weeklyBudgetSats`
   *   an amount       between `leastSats` and `mostSats` (a critical bug above that is the owner's own call: a higher `mostSats` for that one approval)
   * Answers { ok, report } or { ok: false, why } naming the rule.
   */
  function approve(id, amountSats, { played, excluded = new Set(), rules = REWARD_DEFAULTS, severity = null, by = null, nowMs = Date.now() } = {}) {
    const r = get.get(String(id));
    if (!r) return { ok: false, why: 'no such report' };
    if (r.state !== STATES.NEW) return { ok: false, why: `${/^[aeiou]/.test(r.state) ? 'an' : 'a'} ${r.state} report is not approved for money${r.state === STATES.DUPLICATE ? ': the first report of it is' : ''}` };
    const sats = Number(amountSats);
    const R = { ...REWARD_DEFAULTS, ...(rules || {}) };
    if (!Number.isInteger(sats) || sats < R.leastSats || sats > R.mostSats) return { ok: false, why: `an amount is ${R.leastSats} to ${R.mostSats} sat` };
    if (excluded.has(r.pubkey)) return { ok: false, why: 'that key is ours (team, admin or bot): never paid' };
    if (typeof played !== 'function' || played(r.pubkey) !== true) return { ok: false, why: 'that key has not finished a round on the network: only players are rewarded' };
    const since = nowMs - WEEK_MS;
    const mine = db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE pubkey = ? AND state IN ('accepted', 'paid') AND changed_ms >= ?`).get(r.pubkey, since).n;
    if (mine >= R.perKeyPerWeek) return { ok: false, why: `that key has ${mine} rewards this week: at most ${R.perKeyPerWeek}` };
    const week = db.prepare(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM reports WHERE state IN ('accepted', 'paid') AND changed_ms >= ?`).get(since).s;
    if (week + sats > R.weeklyBudgetSats) return { ok: false, why: `this week's budget: ${week} of ${R.weeklyBudgetSats} sat approved, ${sats} more does not fit` };
    db.prepare('UPDATE reports SET state = ?, amount_sats = ?, severity = ?, changed_ms = ? WHERE id = ? AND state = ?').run(STATES.ACCEPTED, sats, severity, nowMs, r.id, STATES.NEW);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, STATES.ACCEPTED, nowMs, by, `${sats} sat${severity ? `, ${severity}` : ''}`);
    return { ok: true, report: row(get.get(r.id)) };
  }

  // ---- THE REWARD (kanban #1342 section 3): one LNURL-withdraw per approved report, for exactly its amount, single use, never expiring ----
  const rewardRow = (w) => (w ? { k1: w.k1, report: w.report, pubkey: w.pubkey, amountSats: w.amount_sats, network: w.network, createdMs: w.created_ms, state: w.state,
    paymentHash: w.payment_hash || null, paidMs: w.paid_ms ?? null, why: w.why || null } : null);
  const rewardOf = db.prepare('SELECT * FROM rewards WHERE k1 = ?');

  /** THE LINK FOR AN ACCEPTED REPORT: made once (asked again, the same k1). `network` the payout network ('testnet4' in phase 1). */
  function createReward(id, { network = 'testnet4', nowMs = Date.now(), by = null } = {}) {
    const r = get.get(String(id));
    if (!r) return { ok: false, why: 'no such report' };
    const had = db.prepare('SELECT * FROM rewards WHERE report = ?').get(r.id);
    if (had) return { ok: true, reward: rewardRow(had), made: false };
    if (r.state !== STATES.ACCEPTED || !(r.amount_sats > 0)) return { ok: false, why: 'only an approved report with its amount gets a reward link' };
    const k1 = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms) VALUES (?, ?, ?, ?, ?, ?)').run(k1, r.id, r.pubkey, r.amount_sats, String(network), nowMs);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, r.state, nowMs, by, `reward link made, ${r.amount_sats} sat on ${network}`);
    return { ok: true, reward: rewardRow(rewardOf.get(k1)), made: true };
  }

  /** LUD-03's first answer, at `<base>/lnurlw/<k1>`: the request a wallet reads; an ERROR for a paid or unknown link. */
  function withdrawRequest(k1, { base }) {
    const w = rewardOf.get(String(k1));
    if (!w) return { status: 'ERROR', reason: 'no such reward' };
    if (w.state === 'paid') return { status: 'ERROR', reason: 'this reward was claimed' };
    if (w.state === 'paying') return { status: 'ERROR', reason: 'this reward is being paid: try again in a minute' };
    const msat = w.amount_sats * 1000;
    return { tag: 'withdrawRequest', callback: `${base}/lnurlw/${w.k1}/callback`, k1: w.k1, minWithdrawable: msat, maxWithdrawable: msat,
      defaultDescription: `Bitcoin Arena feedback reward, ${w.amount_sats} sat${w.network === 'mainnet' ? '' : ' (testnet sats, no value)'}` };
  }
  /** The link a wallet scans: LUD-01 bech32 of `<base>/lnurlw/<k1>`. */
  const lnurlOf = (k1, { base }) => lnurlFor(`${base}/lnurlw/${k1}`);

  /**
   * LUD-03's callback: pay `invoice` for exactly the reward's amount, once. The row moves open -> paying with a compare-and-set before anything is
   * paid, so two claims never both pay. `decode(invoice)` -> { ok, amountSats, paymentHash } and `pay(invoice)` -> { ok, paymentHash } | { ok: false,
   * failed: true } (a payment that surely did not go) | { ok: false } (not known): only a sure failure opens the link again; an unknown stays
   * paying, for settle() to read. Answers LUD-03's { status: 'OK' } or { status: 'ERROR', reason }.
   */
  async function claim(k1, invoice, { decode, pay, nowMs = Date.now() } = {}) {
    const w = rewardOf.get(String(k1));
    if (!w) return { status: 'ERROR', reason: 'no such reward' };
    if (w.state !== 'open') return { status: 'ERROR', reason: w.state === 'paid' ? 'this reward was claimed' : 'this reward is being paid' };
    let d;
    try { d = await decode(String(invoice || '')); } catch { d = { ok: false }; }
    if (!d || !d.ok) return { status: 'ERROR', reason: 'that invoice could not be read' };
    if (Number(d.amountSats) !== w.amount_sats) return { status: 'ERROR', reason: `the invoice must be for exactly ${w.amount_sats} sat` };
    const took = db.prepare("UPDATE rewards SET state = 'paying', invoice = ?, payment_hash = ?, tried_ms = ? WHERE k1 = ? AND state = 'open'").run(String(invoice), d.paymentHash || null, nowMs, w.k1);
    if (took.changes !== 1) return { status: 'ERROR', reason: 'this reward is being paid' };
    let p;
    try { p = await pay(String(invoice)); } catch (e) { p = { ok: false, why: e.message }; }
    if (p && p.ok) { paidNow(w, p.paymentHash || d.paymentHash, nowMs); return { status: 'OK' }; }
    if (p && p.failed) { db.prepare("UPDATE rewards SET state = 'open', why = ? WHERE k1 = ? AND state = 'paying'").run(String(p.why || 'the payment failed'), w.k1); return { status: 'ERROR', reason: 'the payment failed: try again' }; }
    db.prepare("UPDATE rewards SET why = ? WHERE k1 = ?").run(String((p && p.why) || 'the payment\'s outcome is not known yet'), w.k1);
    return { status: 'ERROR', reason: 'the payment is not settled yet: it is checked again, do not claim twice' };
  }
  function paidNow(w, paymentHash, nowMs) {
    db.prepare("UPDATE rewards SET state = 'paid', payment_hash = COALESCE(?, payment_hash), paid_ms = ?, why = NULL WHERE k1 = ?").run(paymentHash || null, nowMs, w.k1);
    const r = get.get(w.report);
    if (r && r.state === STATES.ACCEPTED) {
      db.prepare('UPDATE reports SET state = ?, changed_ms = ? WHERE id = ?').run(STATES.PAID, nowMs, r.id);
      db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, STATES.PAID, nowMs, 'lnurlw', paymentHash || null);
    }
  }
  /**
   * A PAYMENT WHOSE OUTCOME WAS NOT KNOWN (a restart mid-pay, a timeout): `status(paymentHash)` -> 'paid' | 'failed' | 'unknown', the payer's own
   * record. Paid: the reward and the report are paid. Failed: the link opens again. Unknown: it stays paying.
   */
  async function settle({ status, nowMs = Date.now() } = {}) {
    const out = [];
    for (const w of db.prepare("SELECT * FROM rewards WHERE state = 'paying'").all()) {
      let st = 'unknown';
      try { st = w.payment_hash ? await status(w.payment_hash) : 'unknown'; } catch { st = 'unknown'; }
      if (st === 'paid') paidNow(w, w.payment_hash, nowMs);
      else if (st === 'failed') db.prepare("UPDATE rewards SET state = 'open', why = 'the payment failed' WHERE k1 = ? AND state = 'paying'").run(w.k1);
      out.push({ k1: w.k1, status: st });
    }
    return out;
  }
  const rewards = ({ pubkey = null } = {}) => (pubkey ? db.prepare('SELECT * FROM rewards WHERE pubkey = ? ORDER BY created_ms DESC').all(String(pubkey))
    : db.prepare('SELECT * FROM rewards ORDER BY created_ms DESC').all()).map(rewardRow);

  /** The admin list (slice 4 builds on it): every report, newest first, filtered by state, type, game or key. */
  function list({ state = null, type = null, game = null, pubkey = null, limit = 500 } = {}) {
    const where = [], args = [];
    for (const [col, v] of [['state', state], ['type', type], ['game', game], ['pubkey', pubkey]]) if (v) { where.push(`${col} = ?`); args.push(String(v)); }
    return db.prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_ms DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 500, 5000)).map(row);
  }

  return { take, mine, move, approve, list, createReward, withdrawRequest, lnurlOf, claim, settle, rewards, reward: (k1) => rewardRow(rewardOf.get(String(k1))), report: (id) => row(get.get(String(id))), close: () => db.close(), eventId };
}

/**
 * WHO FINISHED A ROUND ON THE NETWORK (kanban #1342, the reading tools/weekly-testers.mjs and founding-badges.mjs make): each game's
 * GET /season?scope=network over `days`, a key with rounds > 0 on any board. Read from the first seat that answers, kept `keepMs`.
 * `fetcher` and `seats` injected; answers played(pubkeyHex) -> true | false, and refresh() to read now.
 */
export function networkPlayers({ seats, games, days = 90, keepMs = 10 * 60 * 1000, fetcher = fetch } = {}) {
  let keys = new Set(), at = 0, reading = null;
  async function refresh() {
    const next = new Set();
    for (const g of games) {
      for (const seat of seats) {
        try {
          const r = await fetcher(`${String(seat).replace(/\/$/, '')}/season?scope=network&game=${encodeURIComponent(g)}&days=${days}`, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) continue;
          const b = await r.json();
          for (const row of b.rows || []) if (Number(row.rounds) > 0 && /^[0-9a-f]{64}$/i.test(String(row.player || ''))) next.add(String(row.player).toLowerCase());
          break;
        } catch { /* the next seat */ }
      }
    }
    keys = next; at = Date.now();
    return keys.size;
  }
  return {
    refresh,
    played: (pubkey) => keys.has(String(pubkey || '').toLowerCase()),
    async fresh() { if (Date.now() - at > keepMs) { reading = reading || refresh().finally(() => { reading = null; }); await reading; } return keys.size; },
  };
}
