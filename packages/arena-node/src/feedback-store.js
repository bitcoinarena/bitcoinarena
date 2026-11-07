// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYER FEEDBACK, KEPT FOR REVIEW (kanban #1342, slice 1). A report is a Nostr event the player's own key signs, so nobody files one in another
// player's name and a reward can only ever go to the key that wrote it. The faucet keeps every report in one SQLite file with a state a human moves:
// new -> accepted | rejected (with a reason the player sees) | duplicate (of an earlier report); accepted -> paid | rejected. Nothing here pays and
// nothing moves on its own. "My feedback" is asked with a NIP-98 HTTP-auth event by the same key: a report's reward link is a bearer secret, so the
// list is never read by its pubkey alone.
import { DatabaseSync } from 'node:sqlite';
import { eventId, eventRefusal } from './nostr-relay.js';

/** The report's kind: ephemeral (20000-29999), so no relay keeps it - it goes to the faucet only. */
export const FEEDBACK_KIND = 27842;
/** NIP-98 HTTP auth. */
export const HTTP_AUTH_KIND = 27235;
export const FEEDBACK_TYPES = Object.freeze(['bug', 'confusing', 'idea']);
export const STATES = Object.freeze({ NEW: 'new', ACCEPTED: 'accepted', REJECTED: 'rejected', DUPLICATE: 'duplicate', PAID: 'paid' });
const NEXT = Object.freeze({ new: ['accepted', 'rejected', 'duplicate'], accepted: ['paid', 'rejected'], rejected: [], duplicate: [], paid: [] });
export const TEXT_MOST = 4000;
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
    CREATE TABLE IF NOT EXISTS report_moves (id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, at_ms INTEGER NOT NULL, by TEXT, note TEXT);`);
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

  /** The admin list (slice 4 builds on it): every report, newest first, filtered by state, type, game or key. */
  function list({ state = null, type = null, game = null, pubkey = null, limit = 500 } = {}) {
    const where = [], args = [];
    for (const [col, v] of [['state', state], ['type', type], ['game', game], ['pubkey', pubkey]]) if (v) { where.push(`${col} = ?`); args.push(String(v)); }
    return db.prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_ms DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 500, 5000)).map(row);
  }

  return { take, mine, move, list, report: (id) => row(get.get(String(id))), close: () => db.close(), eventId };
}
