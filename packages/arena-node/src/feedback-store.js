// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYER FEEDBACK, KEPT FOR REVIEW (kanban #1342, slice 1). A report is a Nostr event the player's own key signs, so nobody files one in another
// player's name and a reward can only ever go to the key that wrote it. The faucet keeps every report in one SQLite file with a state a human moves:
// new -> accepted | rejected (with a reason the player sees) | duplicate (of an earlier report); accepted -> paid | rejected. Nothing here pays and
// nothing moves on its own. "My feedback" is asked with a NIP-98 HTTP-auth event by the same key: a report's reward link is a bearer secret, so the
// list is never read by its pubkey alone.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { walletUrlRefusal, publicFetch, checkedFetch, internalAddress, guardedLookup } from './public-fetch.js';
import { lnurlFor, urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { eventId, eventRefusal } from './nostr-relay.js';
import { BIP39_ENGLISH } from '../../arena-client/src/bip39-wordlist.js';
import { readJsonBounded } from './lnurl-read.js';
import { seedRunSpans } from './seed-phrase.js';

/** The report's kind: ephemeral (20000-29999), so no relay keeps it - it goes to the faucet only. */
export const FEEDBACK_KIND = 27842;
// THE PAYOUT WALLET IS NOT READY (kanban #2412, feedback #016): what a claim or an address payout answers while the bounty lnd is locked or down - the
// reward is not touched (it stays open) and the invoice is not blamed
export const PAYOUTS_PAUSED = 'payouts are paused (the payout wallet is not ready): your reward stays open - try again later';
/** NIP-98 HTTP auth. */
export const HTTP_AUTH_KIND = 27235;
// THE CATEGORIES (Daniel 2026-11-07: "eine Kategorie bug / improvement"), and where a report came from: the game page or a node's owner page
export const FEEDBACK_TYPES = Object.freeze(['bug', 'improvement']);
export const FEEDBACK_SOURCES = Object.freeze(['frontend', 'node']);
export const TEXT_LEAST = 50;   // Daniel 2026-11-07: "minimum von 50 Zeichen"
export const STATES = Object.freeze({ NEW: 'new', ACCEPTED: 'accepted', REJECTED: 'rejected', DUPLICATE: 'duplicate', PAID: 'paid' });
const NEXT = Object.freeze({ new: ['accepted', 'rejected', 'duplicate'], accepted: ['paid', 'rejected'], rejected: [], duplicate: [], paid: [] });
export const TEXT_MOST = 4000;
// THE REWARD RULES (kanban #1342 section 2): settings the owner can change; testnet sats in phase 1
// the weekly budget: 100,000 sats (Daniel 2026-11-10: "Wir haben auch ein Budget von 100000 sats pro Woche")
// NO LIMIT PER PERSON (kanban #2622, Daniel 2026-11-13: the rules as Season 1 was really paid - one tester 21 paid reports, another 15): perKeyPerWeek null
export const REWARD_DEFAULTS = Object.freeze({ perKeyPerWeek: null, weeklyBudgetSats: 100000, mostSats: 20000, leastSats: 100 });
/**
 * THE REWARD LEVELS (Daniel 2026-11-08, final: "500 / 1,000 / 2,000 / 5,000 / 20,000"): one table the feedback form shows and the approval pays from,
 * so form and payout never differ. A critical bug is outside the weekly budget. A node bounty's base is its own pot (#1342 node bounty).
 */
/** A report's number as people say it (kanban #1413): "Feedback #007"; three digits at least, more as the count grows. */
export const feedbackLabel = (n) => (Number.isInteger(Number(n)) && Number(n) > 0 ? `Feedback #${String(Number(n)).padStart(3, '0')}` : null);
export const REWARD_LEVELS = Object.freeze([
  Object.freeze({ level: 'useful', label: 'Useful feedback', sats: 500, example: 'A clear note on what confused you, with the screen and the step.' }),
  Object.freeze({ level: 'low', label: 'Bug, low', sats: 1000, example: 'A wrong text or a layout glitch that does not stop play.' }),
  Object.freeze({ level: 'medium', label: 'Bug, medium', sats: 2000, example: 'A round or a deposit that needs a retry to go through.' }),
  Object.freeze({ level: 'high', label: 'Bug, high', sats: 5000, example: 'Play or a payout stops and only a reload or a restart helps.' }),
  // CRITICAL 10,000 (Daniel 2026-11-10: "Mach 20000 critical zu 10000 sats")
  Object.freeze({ level: 'critical', label: 'Bug, critical', sats: 10000, outsideBudget: true, example: 'Money can be lost or taken, or the result is wrong.' }),
]);
// 10,000 FOR A NODE (Daniel 2026-11-10: "Man kriegt 10000 sats extra wenn man eine node installiert hat + X sats für jeden bug")
export const NODE_BOUNTY_BASE_SATS = 10000;
/** THE NODE BOUNTY (#1342): its own pot - outside the bug budget, one per person, the first `NODE_BOUNTY_MOST` outside nodes; only a node report. */
export const NODE_BOUNTY_MOST = 10;
const NODE_LEVEL = Object.freeze({ level: 'node', label: 'Node bounty', sats: NODE_BOUNTY_BASE_SATS, outsideBudget: true, node: true });
export const levelOf = (name) => (String(name || '').toLowerCase() === 'node' ? NODE_LEVEL : REWARD_LEVELS.find((x) => x.level === String(name || '').toLowerCase()) || null);
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const REPORT_AGE_MOST_S = 24 * 3600;     // a report signed more than a day ago is not taken (a replayed one)
export const AUTH_AGE_MOST_S = 60;

// THE SAME SCRUB AS THE CHAT POST (faucet.js feedbackDecide): an nsec, a 64-hex secret or a seed phrase never stays in a kept report
// NO SEED PHRASE IN A REPORT, IN ANY SPELLING (kanban #1472, feedback #005 by Hexbox Tools 2026-11-11: the phrase rule took 12-24 lowercase words split by
// spaces only - "Abandon, Ability, ..." or "1. abandon 2. ability ..." went through): a run of 12 to 24 BIP39 words in any case, each may carry its number
// ("1.", "2)", "3:"), split by spaces, new lines, commas, semicolons, slashes or dashes, is removed. Only BIP39 words count, so an ordinary sentence of 12
// words stays. nsec/ncryptsec keys and 64-hex secrets are removed as before.
// ONE SEED RULE FOR THE STORE, THE FAUCET AND THE LOGS (kanban #1737, #1799, #1843, #1858, refute of #1472): the run is found by seed-phrase.js
// seedRunSpans, the same function log-level.js redact masks with - any non-letter between the words (list numbers in any layout, a tab table, a JSON
// array, quotes, dots, underscores, "+", zero-width spaces), 4-letter BIP39 prefixes counted as their words. A list number just before the first word
// ("1.", "(1)", "#1", "1-") goes with the run.
// EVERY WALLET KEY SPELLING, NOT ONLY NSEC AND BARE HEX (kanban #2632, a bypass of #1472): an extended private key (xprv/tprv/yprv/zprv/uprv/vprv and
// the multisig Yprv/Zprv/Uprv/Vprv, 111 base58 characters), a 64-hex key glued to anything that is not hex ("0x" + 64 hex: \b never falls between the x
// and the hex; "key_<hex>" alike) and a WIF private key (5/K/L mainnet, 9/c testnet, 51 or 52 base58 characters) went through and reached the stored
// report and the chat post. scrubKeys is the one door every report passes (take's happened/expected, the kept event's content and tags, the debug read,
// faucet.js feedbackDecide), so the keys are removed here by their shape. A key with a typo still counts: nothing checks its checksum.
const WALLET_KEYS = Object.freeze([
  /\b(nsec|ncryptsec)1[0-9a-z]{20,}\b/gi,
  /\b[xtyzuvXYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/g,
  /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi,
  /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
]);
export const scrubKeys = (t) => {
  let s = String(t);
  for (const re of WALLET_KEYS) s = s.replace(re, '[removed]');
  for (const [a, b] of seedRunSpans(s).reverse()) {
    const lead = /[#(]?\d{1,2}[ \t]*[.):-]?[ \t]*$/.exec(s.slice(0, a));
    s = s.slice(0, lead ? lead.index : a) + '[removed]' + s.slice(b);
  }
  return s;
};
// WHAT IS KEPT OF THE SIGNED EVENT (kanban #1737, #1799, #1843, #1858): the event as kept had its raw content - the seed the columns had lost stayed on
// disk in `event`, and `debug` was scrubbed only when read. The kept copy now holds every string of the content scrubbed (happened, expected, debug,
// anything else) and every tag value scrubbed but the hex ones the store reads (node, screenshot, round, p, e). Its id and sig stay for reference: the
// signature was checked when the report came in, and the kept copy is not checked again.
const HEX_TAGS = new Set(['node', 'screenshot', 'round', 'p', 'e']);
// ONLY THE SIGNED FIELDS, ONLY THE KNOWN TAGS (kanban #2003, #2016, #2050; refute of #1472): a field beside the NIP-01 ones ({ ...e } kept it, the id
// covers none of it) and a tag of another name (its name was kept raw) are dropped; every object key is scrubbed as its value is, and a value nested
// deeper than the walk goes is kept as its scrubbed JSON text, never raw. Last, the kept bytes are searched once more as a whole (a seed spread over
// several strings or tags): one still found there keeps the event without its content and with only the tag values the store reads.
// and lud16, the address a report may ask to be paid at (paidAddress reads it; kanban #1590 kept it, checked by its shape below)
const KEPT_TAGS = new Set(['t', 'game', 'round', 'build', 'source', 'node', 'screenshot', 'p', 'e', 'lud16']);
const DEEP_MOST = 32;
const scrubDeep = (v, depth = 0) => (typeof v === 'string' ? scrubKeys(v) : v === null || typeof v !== 'object' ? v
  : depth > DEEP_MOST ? scrubKeys(JSON.stringify(v))
  : Array.isArray(v) ? v.map((x) => scrubDeep(x, depth + 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubKeys(k), scrubDeep(x, depth + 1)])));
const hexTagValue = (t, x, i) => i === 1 && HEX_TAGS.has(t[0]) && typeof x === 'string' && /^[0-9a-f]{8,64}$/.test(x);
const STRICT_TAG = { t: /^(bug|improvement)$/, source: /^(frontend|node)$/, game: /^[a-z0-9-]{1,48}$/, build: /^[0-9a-zA-Z. -]{1,24}$/,
  lud16: /^(?:[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|lnurl1[02-9ac-hj-np-z]+)$/i };
export function keptEvent(e) {
  let content;
  try { content = JSON.stringify(scrubDeep(JSON.parse(e.content))); } catch { content = scrubKeys(String(e.content ?? '')); }
  const tags = (Array.isArray(e.tags) ? e.tags : []).filter((t) => Array.isArray(t) && KEPT_TAGS.has(t[0]))
    .map((t) => t.map((x, i) => (i === 0 || typeof x !== 'string' || hexTagValue(t, x, i) ? x : scrubKeys(x))));
  const kept = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags, content, sig: e.sig };
  if (!seedRunSpans(JSON.stringify([kept.tags, kept.content])).length) return kept;
  const plain = tags.filter((t) => hexTagValue(t, t[1], 1) || (STRICT_TAG[t[0]] && typeof t[1] === 'string' && STRICT_TAG[t[0]].test(t[1]))).map((t) => [t[0], t[1]]);
  return { ...kept, tags: plain, content: JSON.stringify({ removed: 'a seed phrase was found in this report: its content is not kept' }) };
}
const tag = (e, k) => { const t = e.tags.find((x) => x[0] === k); return t ? String(t[1] ?? '') : ''; };
const said = (x, re) => (re.test(String(x || '')) ? String(x) : '');
// (kanban #1590, a bypass of #1472: the report as kept, never as received - keptEvent above, since #2003 / #2016 / #2050 the one rule)

/** THE ADDRESS A SIGNED REPORT ASKED TO BE PAID AT (its content's lnAddress, else its signed lud16 tag): null when it named none or named it wrongly.
 *  THE CHECKED ADDRESS FIRST (kanban #1677): a lud16 tag naming another address never takes the content's place.
 *  ONLY A STRING IS AN ADDRESS (kanban #2468, #1489 audit44 refute of #1677): a content lnAddress of any other shape (["good@wallet"], an object, a
 *  number) was checked at send as String() of it, while this read skipped it and took the tag - an address never checked. A content that names an
 *  lnAddress at all decides alone: a non-string or a malformed string answers null, never the tag. POST /feedback refuses a non-string lnAddress and
 *  checks exactly what this answers (faucet.mjs), so the address paid is the address checked. */
export const LN_ADDRESS_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const LNURL_RE = /^lnurl1[02-9ac-hj-np-z]+$/i;
const addressShape = (a) => (LN_ADDRESS_RE.test(a) || LNURL_RE.test(a) ? a : null);
export function reportAddress(e) {
  if (!e || typeof e !== 'object') return null;
  let c = null; try { c = JSON.parse(e.content); } catch { c = null; }
  const v = c && typeof c === 'object' && !Array.isArray(c) ? c.lnAddress : undefined;
  if (v !== undefined && v !== null && v !== '') {
    if (typeof v !== 'string') return null;   // kanban #2468: never the tag in its place
    if (v.trim()) return addressShape(v.trim());
  }
  const t = Array.isArray(e.tags) ? e.tags.find((x) => Array.isArray(x) && x[0] === 'lud16') : null;
  return t && typeof t[1] === 'string' ? addressShape(t[1].trim()) : null;
}
export function openFeedbackStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  // FREED BYTES ARE ZEROED (kanban #2003, #2016, #2050): a row rewritten without a seed must not leave the seed in the file's free space
  db.exec(`PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, type TEXT NOT NULL, signed_at INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      happened TEXT NOT NULL, expected TEXT NOT NULL, game TEXT, round TEXT, build TEXT, event TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'new', reason TEXT, duplicate_of TEXT, severity TEXT, amount_sats INTEGER, ticket TEXT, changed_ms INTEGER);
    CREATE INDEX IF NOT EXISTS reports_by_key ON reports (pubkey, received_ms);
    CREATE TABLE IF NOT EXISTS report_moves (id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, at_ms INTEGER NOT NULL, by TEXT, note TEXT);
    CREATE TABLE IF NOT EXISTS rewards (k1 TEXT PRIMARY KEY, report TEXT NOT NULL UNIQUE, pubkey TEXT NOT NULL, amount_sats INTEGER NOT NULL, network TEXT NOT NULL,
      created_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', invoice TEXT, payment_hash TEXT, tried_ms INTEGER, paid_ms INTEGER, why TEXT);`);
  // COLUMNS ADDED AFTER THE FIRST FILE (kanban #1342 follow-up): a file from before gains them, null for its old rows
  for (const [col, ddl] of [['source', 'TEXT'], ['node', 'TEXT'], ['screenshot', 'TEXT'], ['number', 'INTEGER']])
    if (!db.prepare('PRAGMA table_info(reports)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE reports ADD COLUMN ${col} ${ddl}`);
  // THE ADMIN'S WORDS WITH A REWARD AND WHERE IT WENT (kanban #1474): the comment sent with the payment, the Lightning address it was paid to
  for (const col of ['comment', 'address'])
    if (!db.prepare('PRAGMA table_info(rewards)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE rewards ADD COLUMN ${col} TEXT`);
  // EVERY REPORT ITS NUMBER (kanban #1413, Daniel 2026-11-10: "Gib jedem feedback eine unique number also Feedback #001 etc wie eine Ticket Number die überall
  // angezeigt wird"): 1, 2, 3 ... in the order the reports came, never reused; the reports of a file from before are numbered once, oldest first
  { const unnumbered = db.prepare('SELECT id FROM reports WHERE number IS NULL ORDER BY received_ms, id').all();
    if (unnumbered.length) { let n = Number(db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM reports').get().n);
      const set = db.prepare('UPDATE reports SET number = ? WHERE id = ?'); for (const r of unnumbered) set.run(++n, r.id); } }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reports_by_number ON reports (number)');
  // A FILE FROM BEFORE (kanban #1737, #1799, #1843, #1858): its kept events held the raw content - each is scrubbed in place once, as take() keeps one now
  // (kanban #2003, #2016, #2050) and so are its words: happened, expected and a rejection's reason under the rule of today, not the one they were
  // kept under. A pass that changed a row then checkpoints the WAL away and VACUUMs, so no old page or frame keeps the raw text on disk.
  { let changed = 0;
    const fix = db.prepare('UPDATE reports SET event = ?, happened = ?, expected = ?, reason = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, event, happened, expected, reason FROM reports').all()) {
      let kept = r.event; try { kept = JSON.stringify(keptEvent(JSON.parse(r.event))); } catch { kept = JSON.stringify(keptEvent({ content: scrubKeys(String(r.event)) })); }
      const happened = scrubKeys(r.happened); const expected = scrubKeys(r.expected); const reason = r.reason === null ? null : scrubKeys(r.reason);
      if (kept !== r.event || happened !== r.happened || expected !== r.expected || reason !== r.reason) { fix.run(kept, happened, expected, reason, r.id); changed++; }
    }
    const fixMove = db.prepare('UPDATE report_moves SET note = ? WHERE rowid = ?');
    for (const m of db.prepare('SELECT rowid AS k, note FROM report_moves WHERE note IS NOT NULL').all()) {
      const note = scrubKeys(m.note); if (note !== m.note) { fixMove.run(note, m.k); changed++; }
    }
    if (changed && path !== ':memory:') db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
  // A PAID REPORT FROM BEFORE GETS ITS APPROVAL TIME BACK (kanban #1786): paidNow used to move changed_ms to the payment time; the approval's move
  // (report_moves, to 'accepted') still holds when it was approved
  db.exec(`UPDATE reports SET changed_ms = (SELECT MAX(m.at_ms) FROM report_moves m WHERE m.id = reports.id AND m.to_state = 'accepted')
    WHERE state = 'paid' AND EXISTS (SELECT 1 FROM report_moves m WHERE m.id = reports.id AND m.to_state = 'accepted')
      AND changed_ms IS NOT (SELECT MAX(m.at_ms) FROM report_moves m WHERE m.id = reports.id AND m.to_state = 'accepted')`);
  // ONE PAYMENT, ONE REWARD (kanban #1925, state audit 2026-11-12): a payment hash is held by at most one paying or paid reward. A file that already holds
  // two keeps opening (the index is then not made); claim() and settle() hold the rule by themselves.
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS rewards_by_payment ON rewards (payment_hash) WHERE payment_hash IS NOT NULL AND state IN ('paying', 'paid')"); } catch { /* an older file with a shared hash */ }
  const get = db.prepare('SELECT * FROM reports WHERE id = ?');
  const row = (r) => (r ? { id: r.id, pubkey: r.pubkey, type: r.type, signedAt: r.signed_at, receivedMs: r.received_ms, happened: r.happened, expected: r.expected,
    game: r.game || null, round: r.round || null, build: r.build || null, state: r.state, reason: r.reason || null, duplicateOf: r.duplicate_of || null,
    severity: r.severity || null, amountSats: r.amount_sats ?? null, ticket: r.ticket || null, changedMs: r.changed_ms ?? null,
    source: r.source || 'frontend', node: r.node || null, screenshot: r.screenshot || null, number: r.number ?? null, label: feedbackLabel(r.number),
    // THE CLIENT'S DEBUG (kanban #1391): what the page sent beside the words, out of the signed event as kept, scrubbed as the words are
    debug: (() => { try { const c = JSON.parse(JSON.parse(r.event).content); return c && c.debug ? scrubKeys(String(c.debug)).slice(0, 60000) : null; } catch { return null; } })() } : null);

  /**
   * A REPORT IN: the signed event, checked as a relay checks one (id, signature), of the report kind, signed within a day. Kept once per event id
   * (a second post of the same event answers the first). Answers { ok, id, kept } or { ok: false, why }.
   */
  function take(e, { nowMs = Date.now(), hasShot = () => true } = {}) {
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
    if (happened.length < TEXT_LEAST) return { ok: false, why: `say what happened in at least ${TEXT_LEAST} characters (${happened.length} so far)` };
    const source = tag(e, 'source') || 'frontend';
    if (!FEEDBACK_SOURCES.includes(source)) return { ok: false, why: `a report comes from ${FEEDBACK_SOURCES.join(' or ')}` };
    const node = source === 'node' ? said(tag(e, 'node'), /^[0-9a-f]{64}$/) : '';
    if (source === 'node' && !node) return { ok: false, why: 'node feedback names the node (its key, 64 hex)' };
    const shot = tag(e, 'screenshot');
    if (shot && (!/^[0-9a-f]{64}$/.test(shot) || !hasShot(shot))) return { ok: false, why: 'that screenshot was not uploaded here' };
    { const had = get.get(e.id); if (had) return { ok: true, id: e.id, kept: false, number: had.number, label: feedbackLabel(had.number) }; }
    db.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, game, round, build, event, source, node, screenshot, number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM reports))`)
      .run(e.id, e.pubkey, type, e.created_at, nowMs, happened, expected, said(tag(e, 'game'), /^[a-z0-9-]{1,48}$/) || null,
        said(tag(e, 'round'), /^[0-9a-f]{8,64}$/) || null, said(tag(e, 'build'), /^[0-9a-zA-Z. -]{1,24}$/) || null, JSON.stringify(keptEvent(e)), source, node || null, shot || null);
    const n = get.get(e.id).number;
    return { ok: true, id: e.id, kept: true, number: n, label: feedbackLabel(n) };
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
    let dupId = null;
    if (to === STATES.DUPLICATE) {
      // named by its id or by its number ("#7", "7", "Feedback #007")
      const num = /^(?:feedback\s*)?#?0*(\d+)$/i.exec(String(duplicateOf || '').trim());
      const of = duplicateOf ? (num ? db.prepare('SELECT * FROM reports WHERE number = ?').get(Number(num[1])) : get.get(String(duplicateOf))) : null;
      if (!of || of.id === r.id) return { ok: false, why: 'a duplicate names the earlier report it repeats' };
      if (of.state === STATES.DUPLICATE) return { ok: false, why: 'name the first report, not another duplicate' };
      if (of.received_ms > r.received_ms) return { ok: false, why: 'the report it repeats came later: the first report keeps its place' };
      dupId = of.id;
    }
    // A REJECTION TAKES ITS REWARD LINK BACK (audit 5 #1402, reproduced: approve, make the link, reject - the link still paid, outside the week's budget):
    // an open link is voided (compare-and-set from open); one being paid or paid keeps the report as it is
    if (to === STATES.REJECTED) {
      const w = db.prepare('SELECT * FROM rewards WHERE report = ?').get(r.id);
      if (w && w.state !== 'open' && w.state !== 'void') return { ok: false, why: `its reward is ${w.state === 'paid' ? 'paid' : 'being paid'}: a paid report stays as it is` };
      if (w && w.state === 'open' && db.prepare("UPDATE rewards SET state = 'void', why = 'the report was rejected' WHERE k1 = ? AND state = 'open'").run(w.k1).changes !== 1)
        return { ok: false, why: 'its reward is being paid: try again in a minute' };
    }
    db.prepare('UPDATE reports SET state = ?, reason = ?, duplicate_of = ?, changed_ms = ? WHERE id = ? AND state = ?')
      .run(to, to === STATES.REJECTED ? String(reason).trim().slice(0, 500) : r.reason, to === STATES.DUPLICATE ? dupId : r.duplicate_of, nowMs, r.id, r.state);
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
    // NO AMOUNT GIVEN: the level's (REWARD_LEVELS); a critical one is outside the weekly budget
    const lv = levelOf(severity);
    const sats = amountSats === undefined || amountSats === null || amountSats === '' ? (lv ? lv.sats : NaN) : Number(amountSats);
    const R = { ...REWARD_DEFAULTS, ...(rules || {}) };
    if (!Number.isInteger(sats) || sats < R.leastSats || sats > R.mostSats) return { ok: false, why: `an amount is ${R.leastSats} to ${R.mostSats} sat` };
    if (excluded.has(r.pubkey)) return { ok: false, why: 'that key is ours (team, admin or bot): never paid' };
    if (lv && lv.node) {
      // A NODE BOUNTY: a node report, one per person, the first NODE_BOUNTY_MOST - its checklist (census, 7 days, owner = this key) is the caller's
      if ((r.source || 'frontend') !== 'node' || !r.node) return { ok: false, why: 'a node bounty is for a node report (from the owner page), naming its node' };
      const paidRows = db.prepare(`SELECT pubkey, node FROM reports WHERE severity = 'node' AND state IN ('accepted', 'paid')`).all();
      const paidNodes = paidRows.map((x) => x.pubkey);
      if (paidNodes.includes(r.pubkey)) return { ok: false, why: 'one node bounty per person: this key has one' };
      // AND ONE PER NODE (audit 5 #1402, reproduced: one node re-claimed by 12 keys took 10 approvals, 200,000 sat)
      if (paidRows.some((x) => x.node && String(x.node) === String(r.node))) return { ok: false, why: 'one node bounty per node: that node has one' };
      if (paidNodes.length >= NODE_BOUNTY_MOST) return { ok: false, why: `the node bounty is for the first ${NODE_BOUNTY_MOST} outside nodes: all are taken` };
    }
    // NO ROUND NEEDED (kanban #2621, Daniel 2026-11-13: "Es muss keiner eine runde gespielt haben, neues req"): a reporter is paid for the report
    // whether or not their key finished a round; `played` stays for the admin view (rounds, apps) only. The other limits stand.
    const since = nowMs - WEEK_MS;
    const mine = db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE pubkey = ? AND state IN ('accepted', 'paid') AND changed_ms >= ?`).get(r.pubkey, since).n;
    if (Number.isFinite(R.perKeyPerWeek) && mine >= R.perKeyPerWeek) return { ok: false, why: `that key has ${mine} rewards this week: at most ${R.perKeyPerWeek}` };
    const week = db.prepare(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM reports WHERE state IN ('accepted', 'paid') AND changed_ms >= ? AND COALESCE(severity, '') NOT IN ('critical', 'node')`).get(since).s;   // a critical one is outside the budget
    if (!(lv && lv.outsideBudget) && week + sats > R.weeklyBudgetSats) return { ok: false, why: `this week's budget: ${week} of ${R.weeklyBudgetSats} sat approved, ${sats} more does not fit` };
    // THE LEVEL AS THE GUARDS READ IT (audit 6, kanban #1422): stored normalised ('Node' was kept as given and missed by the guards' severity = 'node')
    const level = lv ? lv.level : (severity ? String(severity).toLowerCase() : null);
    db.prepare('UPDATE reports SET state = ?, amount_sats = ?, severity = ?, changed_ms = ? WHERE id = ? AND state = ?').run(STATES.ACCEPTED, sats, level, nowMs, r.id, STATES.NEW);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, STATES.ACCEPTED, nowMs, by, `${sats} sat${severity ? `, ${severity}` : ''}`);
    return { ok: true, report: row(get.get(r.id)) };
  }

  // ---- THE REWARD (kanban #1342 section 3): one LNURL-withdraw per approved report, for exactly its amount, single use, never expiring ----
  const rewardRow = (w) => (w ? { k1: w.k1, report: w.report, pubkey: w.pubkey, amountSats: w.amount_sats, network: w.network, createdMs: w.created_ms, state: w.state,
    paymentHash: w.payment_hash || null, paidMs: w.paid_ms ?? null, why: w.why || null, comment: w.comment || null, address: w.address || null } : null);
  const rewardOf = db.prepare('SELECT * FROM rewards WHERE k1 = ?');

  /** THE LINK FOR AN ACCEPTED REPORT: made once (asked again, the same k1). `network` the payout network ('testnet4' in phase 1). */
  function createReward(id, { network = 'testnet4', comment = null, nowMs = Date.now(), by = null } = {}) {
    const r = get.get(String(id));
    if (!r) return { ok: false, why: 'no such report' };
    const said = comment === null || comment === undefined ? null : String(comment).replace(/\s+/g, ' ').trim().slice(0, COMMENT_MOST) || null;
    const had = db.prepare('SELECT * FROM rewards WHERE report = ?').get(r.id);
    if (had) { if (said !== null && had.state === 'open') db.prepare("UPDATE rewards SET comment = ? WHERE k1 = ? AND state = 'open'").run(said, had.k1);
      return { ok: true, reward: rewardRow(rewardOf.get(had.k1)), made: false }; }
    if (r.state !== STATES.ACCEPTED || !(r.amount_sats > 0)) return { ok: false, why: 'only an approved report with its amount gets a reward link' };
    const k1 = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms, comment) VALUES (?, ?, ?, ?, ?, ?, ?)').run(k1, r.id, r.pubkey, r.amount_sats, String(network), nowMs, said);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, r.state, nowMs, by, `reward link made, ${r.amount_sats} sat on ${network}`);
    return { ok: true, reward: rewardRow(rewardOf.get(k1)), made: true };
  }

  /** LUD-03's first answer, at `<base>/lnurlw/<k1>`: the request a wallet reads; an ERROR for a paid or unknown link. */
  function withdrawRequest(k1, { base, network = null }) {
    const w = rewardOf.get(String(k1));
    if (!w) return { status: 'ERROR', reason: 'no such reward' };
    if (!onNetwork(w, network)) return { status: 'ERROR', reason: otherNetwork(w) };   // kanban #1784
    if (w.state === 'paid') return { status: 'ERROR', reason: 'this reward was claimed' };
    if (w.state === 'paying') return { status: 'ERROR', reason: 'this reward is being paid: try again in a minute' };
    if (w.state === 'void' || !reportPays(w)) return { status: 'ERROR', reason: 'this reward was withdrawn: its report is not approved' };
    const msat = w.amount_sats * 1000;
    return { tag: 'withdrawRequest', callback: `${base}/lnurlw/${w.k1}/callback`, k1: w.k1, minWithdrawable: msat, maxWithdrawable: msat,
      defaultDescription: `Bitcoin Arena feedback reward, ${w.amount_sats} sat${w.network === 'mainnet' ? '' : ' (testnet sats, no value)'}${w.comment ? `: ${w.comment}` : ''}`.slice(0, 300) };
  }
  // A LINK PAYS ONLY ON THE NETWORK IT WAS MADE FOR (state audit 2026-11-12 SM-22, kanban #1784): after the payout network switch (testnet4 -> mainnet,
  // 2026-11-11) a testnet4 link was still claimable - and paid in mainnet sats, while its request said "testnet sats, no value". `network` is the
  // faucet's payout network now (null: not checked, as before); a link of another network is refused by withdrawRequest, claim and payToAddress.
  const onNetwork = (w, network) => network == null || String(w.network) === String(network);
  const otherNetwork = (w) => `this reward was made on ${w.network}, and rewards are paid on another network now`;
  /** A reward pays only while its report is approved (audit 5 #1402). */
  const reportPays = (w) => { const r = get.get(w.report); return !!r && (r.state === STATES.ACCEPTED || r.state === STATES.PAID); };
  /** The link a wallet scans: LUD-01 bech32 of `<base>/lnurlw/<k1>`. */
  const lnurlOf = (k1, { base }) => lnurlFor(`${base}/lnurlw/${k1}`);

  /**
   * LUD-03's callback: pay `invoice` for exactly the reward's amount, once. The row moves open -> paying with a compare-and-set before anything is
   * paid, so two claims never both pay. `decode(invoice)` -> { ok, amountSats, paymentHash } and `pay(invoice)` -> { ok, paymentHash } | { ok: false,
   * failed: true } (a payment that surely did not go) | { ok: false } (not known): only a sure failure opens the link again; an unknown stays
   * paying, for settle() to read. Answers LUD-03's { status: 'OK' } or { status: 'ERROR', reason }.
   */
  // THE ADDRESS IS WRITTEN WITH THE PAYMENT IT NAMES (kanban #1575, state audit 2026-11-12, SM-22): `address` was set by payToAddress before claim()'s
  // compare-and-set and stayed when that payment surely failed and the link opened again; the player's own wallet then claimed the link and the paid row
  // named an address that got nothing. Now the address goes into the same UPDATE that takes the row to paying, for that invoice only: a claim through the
  // withdraw link (the LNURL callback) writes NULL, and a payment that surely failed clears it as it opens the link again.
  const claim = (k1, invoice, opts = {}) => claimFor(k1, invoice, opts, null);
  async function claimFor(k1, invoice, { decode, pay, network = null, nowMs = Date.now() } = {}, address = null) {
    const w = rewardOf.get(String(k1));
    if (!w) return { status: 'ERROR', reason: 'no such reward' };
    if (!onNetwork(w, network)) return { status: 'ERROR', reason: otherNetwork(w) };   // kanban #1784
    if (w.state !== 'open') return { status: 'ERROR', reason: w.state === 'paid' ? 'this reward was claimed' : w.state === 'void' ? 'this reward was withdrawn: its report is not approved' : 'this reward is being paid' };
    if (!reportPays(w)) return { status: 'ERROR', reason: 'this reward was withdrawn: its report is not approved' };   // audit 5 #1402
    let d;
    try { d = await decode(String(invoice || '')); } catch { d = { ok: false }; }
    if (d && d.paused) return { status: 'ERROR', reason: PAYOUTS_PAUSED };   // kanban #2412: the wallet's state, not the invoice's
    if (!d || !d.ok) return { status: 'ERROR', reason: 'that invoice could not be read' };
    if (Number(d.amountSats) !== w.amount_sats) return { status: 'ERROR', reason: `the invoice must be for exactly ${w.amount_sats} sat` };
    // AN INVOICE ANOTHER REWARD HOLDS IS REFUSED (kanban #1925): reward Y claimed with the invoice X was already paid with got "invoice is already paid" from
    // lnd, stayed paying, and settle() read X's SUCCEEDED for that hash as Y's payment - Y and its report booked paid, no sat sent. The check is in the
    // compare-and-set itself, and the partial unique index refuses a second holder too.
    const hash = d.paymentHash ? String(d.paymentHash) : null;
    const held = "SELECT 1 FROM rewards WHERE payment_hash = ? AND k1 <> ? AND state IN ('paying', 'paid')";
    if (hash && db.prepare(held).get(hash, w.k1)) return { status: 'ERROR', reason: 'that invoice was used for another reward: make a new invoice' };
    let took;
    try { took = db.prepare(`UPDATE rewards SET state = 'paying', invoice = ?, payment_hash = ?, tried_ms = ?, address = ? WHERE k1 = ? AND state = 'open' AND NOT EXISTS (${held})`).run(String(invoice), hash, nowMs, address, w.k1, hash, w.k1); }
    catch { return { status: 'ERROR', reason: 'that invoice was used for another reward: make a new invoice' }; }
    if (took.changes !== 1) return { status: 'ERROR', reason: 'this reward is being paid' };
    let p;
    try { p = await pay(String(invoice), d.amountSats); } catch (e) { p = { ok: false, why: e.message }; }   // the amount bounds the routing fee (kanban #1450)
    if (p && p.ok) { paidNow(w, p.paymentHash || d.paymentHash, nowMs); return { status: 'OK' }; }
    if (p && p.failed) { db.prepare("UPDATE rewards SET state = 'open', address = NULL, why = ? WHERE k1 = ? AND state = 'paying' AND payment_hash IS ?").run(String(p.why || 'the payment failed'), w.k1, d.paymentHash || null); return { status: 'ERROR', reason: 'the payment failed: try again' }; }   // only its own payment (kanban #1571); the address goes with it (kanban #1575)
    db.prepare("UPDATE rewards SET why = ? WHERE k1 = ?").run(String((p && p.why) || 'the payment\'s outcome is not known yet'), w.k1);
    return { status: 'ERROR', reason: 'the payment is not settled yet: it is checked again, do not claim twice' };
  }
  // `onHash` (kanban #1571): settle() marks paid only the payment it asked about - the row must still be paying under that hash
  function paidNow(w, paymentHash, nowMs, { onHash = undefined } = {}) {
    if (onHash !== undefined) {
      if (db.prepare("UPDATE rewards SET state = 'paid', paid_ms = ?, why = NULL WHERE k1 = ? AND state = 'paying' AND payment_hash = ?").run(nowMs, w.k1, onHash).changes !== 1) return false;
    } else db.prepare("UPDATE rewards SET state = 'paid', payment_hash = COALESCE(?, payment_hash), paid_ms = ?, why = NULL WHERE k1 = ?").run(paymentHash || null, nowMs, w.k1);
    const r = get.get(w.report);
    if (r && r.state === STATES.ACCEPTED) {
      // PAID KEEPS THE APPROVAL TIME (kanban #1786): changed_ms of an accepted or paid report is when it was approved - the per-key limit and the week's
      // budget count by it. The payment time is the reward's paid_ms; moving changed_ms to it counted a reward approved last week and claimed today again
      db.prepare('UPDATE reports SET state = ? WHERE id = ? AND state = ?').run(STATES.PAID, r.id, STATES.ACCEPTED);
      db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, STATES.PAID, nowMs, 'lnurlw', paymentHash || null);
    }
    return true;
  }
  /**
   * A PAYMENT WHOSE OUTCOME WAS NOT KNOWN (a restart mid-pay, a timeout): `status(paymentHash)` -> 'paid' | 'failed' | 'unknown', the payer's own
   * record. Paid: the reward and the report are paid. Failed: the link opens again. Unknown: it stays paying.
   */
  // A PAYMENT STILL GOING IS LEFT ALONE (audit 5 #1402): the payer's own record may not know it yet, and "not found" read as failed reopened the link while
  // claim()'s payinvoice still ran (75 s) - with a hold invoice the holder claimed again and was paid twice. Read only after `freshMs`.
  // ONLY THE PAYER THAT MADE A PAYMENT IS ASKED ABOUT IT (kanban #1784): `status` is the payer of `network`; a paying row of another network was paid by
  // another wallet, which this one never saw ("not listed" read as failed reopened it and the holder was paid twice, once per network) - it stays paying.
  async function settle({ status, network = null, nowMs = Date.now(), freshMs = 180000 } = {}) {
    const out = [];
    // A DECISION HOLDS ONLY FOR THE PAYMENT IT READ (kanban #1571): status() may wait 20 s a row and two passes may overlap, so a row read at the
    // start of a pass can be opened, claimed again and paying under a NEW hash by the time it is decided. Each row is read again before its
    // decision, and the move is a compare-and-set on the hash that was asked about - an answer about an old payment never touches a new one.
    for (const { k1 } of db.prepare("SELECT k1 FROM rewards WHERE state = 'paying'").all()) {
      const w = rewardOf.get(k1);
      if (!w || w.state !== 'paying') continue;
      if (!onNetwork(w, network)) { out.push({ k1: w.k1, status: 'unknown', otherNetwork: w.network }); continue; }   // kanban #1784
      if (Number(w.tried_ms || 0) > nowMs - freshMs) { out.push({ k1: w.k1, status: 'unknown', fresh: true }); continue; }
      // A HASH IS CREDITED ONLY TO THE REWARD THAT FIRST TOOK IT (kanban #1925): a paying reward whose hash another reward holds paid, or took earlier, was
      // not paid by that payment - its link opens again (a file from before the claim() check may hold such a pair)
      const first = db.prepare("SELECT k1 FROM rewards WHERE payment_hash = ? AND state IN ('paying', 'paid') ORDER BY state = 'paid' DESC, tried_ms, rowid LIMIT 1").get(w.payment_hash);
      if (w.payment_hash && first && first.k1 !== w.k1) {
        db.prepare("UPDATE rewards SET state = 'open', why = 'that invoice was another reward''s payment: make a new invoice' WHERE k1 = ? AND state = 'paying'").run(w.k1);
        out.push({ k1: w.k1, status: 'failed', shared: true }); continue;
      }
      let st = 'unknown';
      try { st = w.payment_hash ? await status(w.payment_hash) : 'unknown'; } catch { st = 'unknown'; }
      let moved = false;
      if (st === 'paid') moved = paidNow(w, w.payment_hash, nowMs, { onHash: w.payment_hash });
      else if (st === 'failed') moved = db.prepare("UPDATE rewards SET state = 'open', address = NULL, why = 'the payment failed' WHERE k1 = ? AND state = 'paying' AND payment_hash = ?").run(w.k1, w.payment_hash).changes === 1;   // #1571 own hash, #1575 address cleared
      out.push(st === 'unknown' || moved ? { k1: w.k1, status: st } : { k1: w.k1, status: 'unknown', stale: true });
    }
    return out;
  }
  /** THE ADDRESS A REPORT ASKED TO BE PAID AT (reportAddress below): null when it named none. */
  function addressOf(id) {
    const r = get.get(String(id)); if (!r) return null;
    let e = null; try { e = JSON.parse(r.event); } catch { e = null; }
    return reportAddress(e);
  }
  /**
   * PAID STRAIGHT TO THE REPORT'S LIGHTNING ADDRESS (kanban #1474, Daniel 2026-11-11: "Do we have a function to give a comment when we pay?" - "1, ja. Und zeig es
   * auch in my feedback"): the address is asked for an invoice of exactly the reward (LUD-16/06), with the reward's comment (LUD-12, cut to what the wallet
   * takes), and that invoice goes through claim() - the same compare-and-set, the same payer, the same "an unknown outcome stays paying". `invoiceFor(address,
   * sats, comment)` -> { ok, invoice } | { ok: false, why }. Answers { ok, status } or { ok: false, why }.
   */
  async function payToAddress(k1, { invoiceFor, decode, pay, network = null, nowMs = Date.now() } = {}) {
    const w = rewardOf.get(String(k1));
    if (!w) return { ok: false, why: 'no such reward' };
    if (!onNetwork(w, network)) return { ok: false, why: otherNetwork(w) };   // kanban #1784
    if (w.state !== 'open') return { ok: false, why: w.state === 'paid' ? 'this reward is paid' : w.state === 'void' ? 'this reward was withdrawn' : 'this reward is being paid' };
    const address = addressOf(w.report);
    if (!address) return { ok: false, why: 'the report names no Lightning address: send its withdraw link instead' };
    let inv; try { inv = await invoiceFor(address, w.amount_sats, w.comment || ''); } catch (e) { inv = { ok: false, why: e.message }; }
    if (!inv || !inv.ok) return { ok: false, why: `the address gave no invoice: ${(inv && inv.why) || 'no answer'}` };
    const r = await claimFor(w.k1, inv.invoice, { decode, pay, network, nowMs }, address);   // the address is written with its invoice's paying CAS (kanban #1575)
    return r.status === 'OK' ? { ok: true, status: 'paid', address, reward: rewardRow(rewardOf.get(w.k1)) } : { ok: false, why: r.reason, address, reward: rewardRow(rewardOf.get(w.k1)) };
  }
  const rewards = ({ pubkey = null } = {}) => (pubkey ? db.prepare('SELECT * FROM rewards WHERE pubkey = ? ORDER BY created_ms DESC').all(String(pubkey))
    : db.prepare('SELECT * FROM rewards ORDER BY created_ms DESC').all()).map(rewardRow);

  // ---- THE ADMIN'S OTHER TOOLS (kanban #1342 section 4) ----
  /** A link to a Kanban ticket, and the spec role's severity: notes on the report, no state move. */
  function note(id, { ticket = undefined, severity = undefined, by = null, nowMs = Date.now() } = {}) {
    const r = get.get(String(id));
    if (!r) return { ok: false, why: 'no such report' };
    if (ticket !== undefined && ticket !== null && !/^#?\d{1,6}$/.test(String(ticket))) return { ok: false, why: 'a ticket is its number, like #1342' };
    if (severity !== undefined && severity !== null && !['low', 'medium', 'high', 'critical', 'useful'].includes(String(severity))) return { ok: false, why: 'severity is low, medium, high, critical or useful' };
    // AN APPROVED REPORT KEEPS ITS LEVEL (audit 6, kanban #1422): a note that moved an accepted node bounty to "critical" freed its node for a second
    // bounty and took a report out of the week's budget sum - the level a reward was approved at is what the guards and the budget read
    if (severity !== undefined && severity !== null && (r.state === STATES.ACCEPTED || r.state === 'paid')) return { ok: false, why: `that report is ${r.state}: the level it was approved at stays (${r.severity || 'none'})` };
    db.prepare('UPDATE reports SET ticket = COALESCE(?, ticket), severity = COALESCE(?, severity) WHERE id = ?')
      .run(ticket === undefined || ticket === null ? null : `#${String(ticket).replace(/^#/, '')}`, severity === undefined || severity === null ? null : String(severity), r.id);
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, r.state, nowMs, by, `note: ${ticket ? `ticket ${ticket}` : ''}${severity ? ` severity ${severity}` : ''}`.trim());
    return { ok: true, report: row(get.get(r.id)) };
  }
  /** A LINE ON A REPORT'S LOG without a move (kanban #2623: "moved to Season 2 ..."), shown with its moves. */
  function remark(id, text, { by = null, nowMs = Date.now() } = {}) {
    const r = get.get(String(id)); if (!r) return { ok: false, why: 'no such report' };
    db.prepare('INSERT INTO report_moves (id, from_state, to_state, at_ms, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.state, r.state, nowMs, by, scrubKeys(String(text)).slice(0, 300));
    return { ok: true };
  }
  /** Who did what to a report, oldest first. */
  const moves = (id) => db.prepare('SELECT * FROM report_moves WHERE id = ? ORDER BY at_ms').all(String(id)).map((m) => ({ from: m.from_state, to: m.to_state, atMs: m.at_ms, by: m.by, note: m.note }));
  /** THE BUDGET BAR: approved this week and in all, paid, and links not yet claimed. */
  // THE PUBLIC PAYOUT LOG (kanban #2619): every paid reward with its report's number and severity and the time it was paid, sorted by the
  // report's number - no key, no address, no invoice. bitcoinarena.io/bounty/ reads it live, so a payout shows there the moment it is paid.
  const paidLogRows = db.prepare(`SELECT r.number AS number, r.severity AS severity, w.amount_sats AS sats, w.paid_ms AS paidMs FROM reports r
    JOIN rewards w ON w.report = r.id WHERE w.state = 'paid' ORDER BY r.number`);
  function paidLog() {
    return paidLogRows.all().map((x) => ({ number: Number(x.number), severity: x.severity || null, sats: Number(x.sats), paidMs: x.paidMs == null ? null : Number(x.paidMs) }));
  }
  function budget({ rules = REWARD_DEFAULTS, nowMs = Date.now() } = {}) {
    const R = { ...REWARD_DEFAULTS, ...(rules || {}) };
    const sum = (sql, ...a) => db.prepare(sql).get(...a).s;
    // EVERY APPROVAL OF THE WEEK (Daniel 2026-11-12: "Überall muss 56000 stehen"): the week's figure every page shows counts all approvals of the last
    // 7 days, critical and node ones too, so it matches "approved in all" for a week that holds the whole history. The approval rule keeps its own
    // sum (approve: the budget counts no critical or node approval); weekOutsideBudgetSats names that part
    return { weekApprovedSats: sum(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM reports WHERE state IN ('accepted', 'paid') AND changed_ms >= ?`, nowMs - WEEK_MS),
      // AND WHAT THIS WEEK APPROVED OUTSIDE IT (Daniel 2026-11-12, the admin page: "46,000 of 100,000 approved this week" beside "56,000 approved in
      // all", all of it this week): a critical bug and a node bounty do not count against the weekly budget, so they are shown on their own
      weekOutsideBudgetSats: sum(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM reports WHERE state IN ('accepted', 'paid') AND changed_ms >= ? AND COALESCE(severity, '') IN ('critical', 'node')`, nowMs - WEEK_MS),
      weeklyBudgetSats: R.weeklyBudgetSats, allApprovedSats: sum(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM reports WHERE state IN ('accepted', 'paid')`),
      paidSats: sum(`SELECT COALESCE(SUM(amount_sats), 0) AS s FROM rewards WHERE state = 'paid'`),
      openRewards: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_sats), 0) AS s FROM rewards WHERE state <> 'paid'`).get(),
      counts: Object.fromEntries(db.prepare('SELECT state, COUNT(*) AS n FROM reports GROUP BY state').all().map((x) => [x.state, x.n])) };
  }
  /** THE CSV (the Monday scoreboard, #922): one line per report, with its reward if any. Text cells quoted; a leading =, +, - or @ neutralised. */
  function csv() {
    const cell = (v) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    const head = ['number', 'report', 'received', 'pubkey', 'source', 'node', 'type', 'game', 'state', 'severity', 'amount_sats', 'ticket', 'reason', 'duplicate_of', 'reward_state', 'paid_at', 'payment_hash', 'network', 'happened'];
    const lines = [head.join(',')];
    for (const r of db.prepare('SELECT r.*, w.state AS w_state, w.paid_ms, w.payment_hash AS w_hash, w.network FROM reports r LEFT JOIN rewards w ON w.report = r.id ORDER BY r.received_ms').all())
      lines.push([feedbackLabel(r.number), r.id, new Date(r.received_ms).toISOString(), r.pubkey, r.source || 'frontend', r.node, r.type, r.game, r.state, r.severity, r.amount_sats, r.ticket, r.reason, r.duplicate_of, r.w_state,
        r.paid_ms ? new Date(r.paid_ms).toISOString() : '', r.w_hash, r.network, r.happened].map(cell).join(','));
    return `${lines.join('\n')}\n`;
  }

  /** The admin list (slice 4 builds on it): every report, newest first, filtered by state, type, game or key. */
  function list({ state = null, type = null, game = null, pubkey = null, source = null, limit = 500 } = {}) {
    const where = [], args = [];
    for (const [col, v] of [['state', state], ['type', type], ['game', game], ['pubkey', pubkey], ['source', source]]) if (v) { where.push(`${col} = ?`); args.push(String(v)); }
    return db.prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_ms DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 500, 5000)).map(row);
  }

  const shotsInUse = () => new Set(db.prepare('SELECT screenshot FROM reports WHERE screenshot IS NOT NULL').all().map((x) => x.screenshot));
  /**
   * WHETHER A NODE REPORT GETS THE ONE-TIME NODE BOUNTY (kanban #1453, Daniel 2026-11-11: "in der admin page damit ich das sehe dass er 10k kriegt, weil es sein
   * erstes ticket ist, Tu es vorausfüllen"): by the same rules approve() holds it to - one per node, one per person, the first NODE_BOUNTY_MOST nodes -
   * read before the admin decides. null for a frontend report. { first, sats, takenBy (the report that holds it for this node or key), full }
   */
  function nodeBountyFor(report) {
    if (!report || (report.source || 'frontend') !== 'node' || !report.node) return null;
    const held = db.prepare(`SELECT id, pubkey, node, number FROM reports WHERE severity = 'node' AND state IN ('accepted', 'paid')`).all().filter((x) => x.id !== report.id);
    const self = db.prepare(`SELECT severity, state FROM reports WHERE id = ?`).get(report.id);
    const taken = held.find((x) => x.node && String(x.node) === String(report.node)) || held.find((x) => x.pubkey === report.pubkey) || null;
    const mine = !!(self && self.severity === 'node' && (self.state === 'accepted' || self.state === 'paid'));
    return { first: mine || (!taken && held.length < NODE_BOUNTY_MOST), sats: NODE_BOUNTY_BASE_SATS, held: mine,
      takenBy: taken ? { id: taken.id, label: feedbackLabel(taken.number), sameNode: !!(taken.node && String(taken.node) === String(report.node)) } : null,
      full: !mine && !taken && held.length >= NODE_BOUNTY_MOST };
  }
  return { take, mine, move, approve, list, shotsInUse, note, remark, moves, budget, paidLog, csv, nodeBountyFor, createReward, withdrawRequest, lnurlOf, claim, settle, rewards, payToAddress, addressOf, reward: (k1) => rewardRow(rewardOf.get(String(k1))), report: (id) => row(get.get(String(id))), close: () => db.close(), eventId };
}

/** The most of one seat's GET /season?scope=network answer the faucet reads (kanban #2517). */
export const NETWORK_SEASON_MAX_BYTES = 16 * 1024 * 1024;

/**
 * WHO FINISHED A ROUND ON THE NETWORK (kanban #1342, the reading tools/weekly-testers.mjs and founding-badges.mjs make): each game's
 * GET /season?scope=network over `days`, a key with rounds > 0 on any board. Read from the first seat that answers, kept `keepMs`.
 * `fetcher` and `seats` injected; answers played(pubkeyHex) -> true | false, and refresh() to read now.
 */
export function networkPlayers({ seats, games, days = 90, keepMs = 10 * 60 * 1000, fetcher = fetch } = {}) {
  // AND HOW MANY ROUNDS IN WHICH GAMES (Daniel 2026-11-10: "Sag auch in der Feedback page, wieviel runden der spieler gemacht hat und welche apps er genutzt hat")
  let keys = new Set(), at = 0, reading = null, perGame = new Map();
  // EACH GAME'S PLAYERS AS LAST READ (kanban #2565, measured 2026-11-12: a refresh while no seat answered - one restarting, the rest slow
  // under load - emptied the list and every reward was refused "not finished a round" for 10 min): a game no seat answers keeps its last list
  const lastOf = new Map();   // game -> Map(player -> rounds)
  async function refresh() {
    const next = new Set(), counts = new Map();
    // ONE SEAT'S NETWORK VIEW PER GAME, THE GAMES AT ONCE (kanban #1484, Daniel 2026-11-11: "Is VERY slow, speed it up"): scope=network is the whole network's
    // season merged by the seat asked, so the first seat that answers is the list - reading all 14 one after another (20 s each at most) held the admin page,
    // and 42 at once overloaded the seats' own merge. Per game the seats are asked in turn until one answers
    await Promise.all(games.map(async (g) => {
      for (const seat of seats) {
        try {
          const r = await fetcher(`${String(seat).replace(/\/$/, '')}/season?scope=network&game=${encodeURIComponent(g)}&days=${days}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });   // kanban #1884: a configured seat is asked as given, never redirected
          if (!r.ok) continue;
          // READ TO A BOUND (kanban #2517): a season seat's network board is a few hundred KB; r.json() took whatever one seat sent
          const b = await readJsonBounded(r, NETWORK_SEASON_MAX_BYTES);
          const read = new Map();
          for (const row of b.rows || []) if (Number(row.rounds) > 0 && /^[0-9a-f]{64}$/i.test(String(row.player || ''))) {
            const k = String(row.player).toLowerCase(); read.set(k, (read.get(k) || 0) + Number(row.rounds)); }
          lastOf.set(g, read);
          return;
        } catch { /* that seat does not answer: the next one */ }
      }
    }));
    for (const g of games) for (const [k, n] of lastOf.get(g) || []) {
      next.add(k); const m = counts.get(k) || {}; m[g] = (m[g] || 0) + n; counts.set(k, m); }
    keys = next; perGame = counts; at = Date.now();
    return keys.size;
  }
  return {
    refresh,
    played: (pubkey) => keys.has(String(pubkey || '').toLowerCase()),
    // { rounds, games: [[game, rounds], ...] } in the network season of `days`, the most played first; none: rounds 0
    history: (pubkey) => { const m = perGame.get(String(pubkey || '').toLowerCase()) || {}; const games = Object.entries(m).sort((a, b) => b[1] - a[1]);
      return { rounds: games.reduce((t, [, n]) => t + n, 0), games, days }; },
    // A LIST IN HAND IS ANSWERED AT ONCE (kanban #1484): a stale one is refreshed in the background; only the very first read is waited for
    async fresh() { if (Date.now() - at > keepMs) { reading = reading || refresh().finally(() => { reading = null; }); if (!at) await reading; } return keys.size; },
  };
}

// ---- SCREENSHOTS (Daniel 2026-11-07: "braucht einen Screenshot upload") ----
// Uploaded before the report is signed, kept in a folder under their SHA-256; the report names that hash in a 'screenshot' tag, so the signature
// covers which image goes with it. PNG, JPEG or WebP only (read by their first bytes, not a header someone sends), at most SHOT_MOST bytes.
// A file no report names after SHOT_UNCLAIMED_MS is removed (sweepShots).
export const SHOT_MOST = 1_500_000;
export const SHOT_UNCLAIMED_MS = 24 * 3600 * 1000;
export function imageKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

/**
 * DOES THIS LIGHTNING ADDRESS WORK (Daniel 2026-11-10, #1342: "Die lnd addresse muss validiert werden ob die funktioniert"): a Lightning address
 * (name@domain, LUD-16) is asked at https://domain/.well-known/lnurlp/name, an LNURL (LUD-01) at the URL it encodes; it works when that answers a
 * pay request (LUD-06: tag payRequest, a callback) within `timeoutMs`. `fetchFn` is the caller's fetch. Answers { ok } or { ok: false, why }.
 */
// a reward's comment: at most this many characters (LUD-12 wallets take 100-255; the address's own commentAllowed cuts it further)
export const COMMENT_MOST = 200;

// ---- A WALLET IS ASKED ON THE PUBLIC INTERNET ONLY (kanban #1511, #1677, #1689, #1746, #1809, #1962) ----
// The guard lives in public-fetch.js (kanban #1919: every seat's payout asks use it too) and is re-exported here: a public name
// (walletUrlRefusal - no IP literal, no local-only or tailnet name, the default HTTPS port only), a public resolved address (guardedLookup in
// publicFetch: DNS rebinding between the check and the connect cannot swap it), and a redirect followed by hand only - at most REDIRECTS_MOST
// hops, each Location checked exactly as the first URL (#1962: name@own-domain answering 301 to its wallet provider works; #1746: a 302 to an
// internal URL is never fetched). An injected fetchFn is asked with redirect: 'manual' and its hops are checked the same way.
export { internalAddress, walletUrlRefusal, guardedLookup, publicFetch } from './public-fetch.js';
// and the a45 #2236 name for the faucet's and the winnings send's one guard by where a name leads (kanban #1809, #2236)
export { hostReach } from './public-fetch.js';
// kanban #2454: the zap address tool dials a receipt's relay only through this lookup (global addresses, checked at connect)
export { guardedLookup as globalLookup } from './public-fetch.js';
// the names #1511 / #1809 gave these checks, kept for their callers: a URL on a public name, an address that is global, one pinned GET
export const publicHttpsUrl = (u) => !walletUrlRefusal(u);
export const addressIsGlobal = (address) => !internalAddress(address);
export const walletFetch = (url, { signal, headers } = {}) => publicFetch(url, { signal, headers });
// BY WHERE THE NAME LEADS FOR ANY FETCHER (kanban #1809): publicFetch checks the resolved address at its connect, but an injected fetcher
// connects as it likes - so before one is asked, the name is resolved here and a name leading to an internal address is refused (EINTERNALHOST).
// A name that does not resolve now is left to the fetch, which fails on its own.
const leadsInternal = (u) => new Promise((resolve) => {
  let host; try { host = new URL(String(u)).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { resolve(true); return; }
  guardedLookup(host, {}, (err) => resolve(!!err && err.code === 'EINTERNALHOST'));
});
// NEVER INSIDE THE FAUCET'S OWN NETWORK (kanban #2045, #2064, refute 3 of #1537): the faucet's own team hosts (FAUCET_TEAM_HOSTS) are refused by
// name too - the first URL and every redirect hop
function teamHosts() { return String(process.env.FAUCET_TEAM_HOSTS || 'tn4.bitcoin-arena.io').split(',').map((x) => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean); }
const onTeamHost = (url) => { let h = ''; try { h = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return true; } return teamHosts().some((t) => h === t || h.endsWith(`.${t}`)); };
const walletRefusal = (url) => walletUrlRefusal(url) || (onTeamHost(url) ? 'its wallet must be on a public name' : null);
const walletGet = async (fetchFn, u, timeoutMs) => {
  if (fetchFn !== publicFetch && await leadsInternal(u)) throw Object.assign(new Error('its wallet must be on a public name'), { code: 'EINTERNALHOST' });
  return checkedFetch(u, { fetchFn, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, refusal: walletRefusal });
};
/**
 * WHERE AN ADDRESS IS ASKED, BEFORE ANYTHING IS FETCHED (kanban #1873, #1905): { ok, url } for a Lightning address or an LNURL on a public HTTPS
 * name, else { ok: false, why }. The faucet takes a slot of its address-check minute only for an address that passes this, so text that is no
 * address costs nothing and can never fill the minute.
 */
export function lnAddressUrl(address) {
  const a = String(address || '').trim();
  let url = null;
  const m = /^([a-z0-9._+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(a);
  if (m) url = `https://${m[2].toLowerCase()}/.well-known/lnurlp/${encodeURIComponent(m[1].toLowerCase())}`;
  else if (/^lnurl1[02-9ac-hj-np-z]+$/i.test(a)) { try { url = urlOfLnurl(a.toLowerCase()); } catch { url = null; } }
  if (!url || !/^https:\/\//.test(url)) return { ok: false, why: 'that is not a Lightning address (name@wallet.com) or an LNURL' };
  const refused = walletRefusal(url); if (refused) return { ok: false, why: refused };
  return { ok: true, url };
}

export async function lnAddressWorks(address, { fetchFn = publicFetch, timeoutMs = 8000 } = {}) {
  const a = String(address || '').trim();
  let url = null;
  const m = /^([a-z0-9._+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(a);
  if (m) url = `https://${m[2].toLowerCase()}/.well-known/lnurlp/${encodeURIComponent(m[1].toLowerCase())}`;
  else if (/^lnurl1[02-9ac-hj-np-z]+$/i.test(a)) { try { url = urlOfLnurl(a.toLowerCase()); } catch { url = null; } }
  if (!url || !/^https:\/\//.test(url)) return { ok: false, why: 'that is not a Lightning address (name@wallet.com) or an LNURL' };
  // NEVER AN INTERNAL HOST (kanban #1511, #1689, #1746, #1962, #2064): by name here, by resolved address in publicFetch's lookup, each redirect hop the same
  const refused = walletRefusal(url); if (refused) return { ok: false, why: refused };
  let j;
  try {
    const r = await walletGet(fetchFn, url, timeoutMs);
    if (!r.ok) return { ok: false, why: `its wallet answered ${r.status}` };
    // read to at most LNURL_MAX_BYTES (kanban #1563): the address is named by anyone who posts a report, and r.json() took a stranger's
    // whole answer - hundreds of MB ran the faucet (welcomes, node faucet, the mainnet bounty payer) out of memory
    j = await readJsonBounded(r);
  } catch (e) { if (/LNURL answer may be/.test(String(e && e.message))) return { ok: false, why: 'its wallet answered too much' };
    if (e && e.code === 'EINTERNALHOST') return { ok: false, why: 'its wallet must be on a public name' };
    return { ok: false, why: /abort|timeout/i.test(String(e && e.name) + String(e && e.message)) ? 'its wallet did not answer in time' : 'its wallet could not be reached' }; }
  if (!j || j.status === 'ERROR') return { ok: false, why: `its wallet said: ${String((j && j.reason) || 'error').slice(0, 120)}` };
  if (j.tag !== 'payRequest' || typeof j.callback !== 'string' || !/^https:\/\//.test(j.callback)) return { ok: false, why: 'its wallet does not take payments at that address' };
  if (!publicHttpsUrl(j.callback)) return { ok: false, why: 'its wallet must be on a public name' }; // its callback too (kanban #1677)
  return { ok: true, minSats: Math.ceil(Number(j.minSendable || 0) / 1000), maxSats: Math.floor(Number(j.maxSendable || 0) / 1000) };
}

/**
 * AN INVOICE FROM A LIGHTNING ADDRESS (kanban #1474): LUD-16 name@domain (or an LNURL, LUD-01) -> its pay request (LUD-06) -> its callback with
 * amount (msat) and the comment (LUD-12, only when the wallet takes one, cut to its commentAllowed). Answers { ok, invoice, commentSent } or { ok: false, why }.
 * The caller's decode() then checks the invoice is for exactly the amount (claim()).
 */
export async function lnAddressInvoice(address, sats, comment = '', { fetchFn = publicFetch, timeoutMs = 10000 } = {}) {
  const a = String(address || '').trim();
  const m = /^([a-z0-9._+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(a);
  let url = m ? `https://${m[2].toLowerCase()}/.well-known/lnurlp/${encodeURIComponent(m[1].toLowerCase())}` : null;
  if (!url && /^lnurl1[02-9ac-hj-np-z]+$/i.test(a)) { try { url = urlOfLnurl(a.toLowerCase()); } catch { url = null; } }
  if (!url || !/^https:\/\//.test(url)) return { ok: false, why: 'not a Lightning address or an LNURL' };
  // the same guard as lnAddressWorks on BOTH GETs, the callback's included (kanban #1677, #1689, #1746, #1809, #1962): a public name, a public
  // address, each redirect hop checked; every answer read bounded (kanban #1563)
  const get = async (u) => { const refused = walletRefusal(u); if (refused) throw new Error(refused);
    let r; try { r = await walletGet(fetchFn, u, timeoutMs); } catch (e) { throw new Error(e && e.code === 'EINTERNALHOST' ? 'its wallet must be on a public name' : 'could not be reached'); }
    if (!r.ok) throw new Error(`answered ${r.status}`); return readJsonBounded(r).catch((e) => { throw /LNURL answer may be/.test(e.message) ? new Error('answered too much') : e; }); };
  let p; try { p = await get(url); } catch (e) { return { ok: false, why: `its wallet: ${e.message}` }; }
  if (!p || p.status === 'ERROR' || p.tag !== 'payRequest' || !/^https:\/\//.test(String(p.callback || ''))) return { ok: false, why: `its wallet takes no payment there${p && p.reason ? `: ${String(p.reason).slice(0, 120)}` : ''}` };
  if (!publicHttpsUrl(p.callback)) return { ok: false, why: 'its wallet must be on a public name' };
  const msat = Number(sats) * 1000;
  if (msat < Number(p.minSendable || 0) || msat > Number(p.maxSendable || Infinity)) return { ok: false, why: `its wallet takes ${Math.ceil(Number(p.minSendable || 0) / 1000)} to ${Math.floor(Number(p.maxSendable || 0) / 1000)} sat` };
  const room = Math.max(0, Math.floor(Number(p.commentAllowed || 0)));
  const said = room ? String(comment || '').slice(0, room) : '';
  const cb = new URL(p.callback); cb.searchParams.set('amount', String(msat)); if (said) cb.searchParams.set('comment', said);
  let i; try { i = await get(cb.toString()); } catch (e) { return { ok: false, why: `its wallet: ${e.message}` }; }
  if (!i || i.status === 'ERROR' || typeof i.pr !== 'string' || !/^ln(bc|tb|bcrt)/i.test(i.pr)) return { ok: false, why: `its wallet gave no invoice${i && i.reason ? `: ${String(i.reason).slice(0, 120)}` : ''}` };
  return { ok: true, invoice: i.pr, commentSent: said };
}
