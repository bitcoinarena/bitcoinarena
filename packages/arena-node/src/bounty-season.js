// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BUG BOUNTY SEASON 2 (kanban #2623, the rules page testnet-stage.bitcoinarena.io/bounty/): a pot of 100,000 sat per one-week season for confirmed
// reports, community bonuses and node bounties; a community bonus from linked Telegram / Discord / X accounts; code-only findings at half; follow-ups
// at 1,000; the node bounty for the first 3 nodes of a season. Its own file (FAUCET_BOUNTY_S2_DB), so Season 1's feedback.db keeps its schema.
// This module only computes and records: paying stays the separate manual step it was (it never calls a wallet).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const SEASON_POT_SATS = 100000;
export const SEASON_MS = 7 * 24 * 3600 * 1000;
export const NO_CARRY_FROM_SEASON = 2;   // kanban #2787 (the owner 2026-11-15: "wenn der Pot voll ist, ist er voll"): from Season 2 on a used-up pot means no bounty, nothing waits
export const FIRST_SEASON = 2;
export const FOLLOW_UP_SATS = 1000;
export const NODE_SATS = 10000;
export const NODES_PER_SEASON = 3;
export const LEVEL_SATS = Object.freeze({ useful: 500, low: 1000, medium: 2000, high: 5000, critical: 10000 });
export const PLATFORMS = Object.freeze(['telegram', 'discord', 'x']);
export const LINK_CODE_MS = 24 * 3600 * 1000;
export const LINK_CODES_OPEN_MOST = 5;
/** A membership read longer ago than this does not count for a bonus or the draw: it is read again first. */
export const CHECK_FRESH_MS = 24 * 3600 * 1000;
// the code a reporter posts: "BA-" and 8 letters/digits without look-alikes (no 0/O, 1/I/L)
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LINK_CODE_RE = /\bBA-([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/i;

/** THE BONUS IN PERCENT from the stored flags: Telegram or Discord member +50, X follower +25, both +75. */
export function bonusPct(flags = {}) {
  const community = !!(flags.telegram || flags.discord);
  return (community ? 50 : 0) + (flags.x ? 25 : 0);
}

/**
 * WHAT ONE APPROVAL PAYS, by the Season 2 rules: the level's sats; a follow-up 1,000; a code-only finding (no real round) half the level; then the
 * community bonus on top. A node bounty is 10,000 flat (it is not a report: no bonus, no half).
 */
// kanban #2784 (the owner 2026-11-15): the full level only when the reporter played a round AND is proven human - at least one verified social account
// (Telegram, Discord or Armada membership, or follows on X); else - a code-only report, or a player with no verified account (a bot) - 25 %.
// kanban #2788 (the owner 2026-11-15: "Um human zu beweisen benoetigen wir einen Twitter [account]"): only a verified X account proves a human now;
// Telegram, Discord and Armada stay a bonus.
// WHAT A BOT GETS (kanban #2784, the owner 2026-11-15: "Setze die Bot-Bounties nur auf 15 % jetzt"): was 25 %
export const BOT_PCT = 15;
export const HUMAN_FLAGS = Object.freeze(['x']);
// NO NODE BOUNTY FOR A BOT (kanban #2876, the owner 2026-11-16 ~07:06Z: "Ab sofort, mit Timestamp jetzt in der Bounty definieren: Bots sind ausgenommen von
// dem 10k sat Bonus, es zaehlt nur das eigentliche Feedback"): a node report received from 2026-11-16T07:06:38Z on whose reporter is not proven human (a
// played round - the owner's played mark counts - AND a verified X account) gets no flat node bounty; it is approved as ordinary feedback at its level
// (the bot share, the bonus as usual). A report received before keeps the old rule.
export const NODE_BOT_EXCLUDED_FROM_MS = 1794812798412;
export const NODE_BOT_EXCLUDED_WHY = 'From 16 Nov 2026 07:06 UTC the 10,000 sat node bounty is only for proven humans (a played round and a linked X account): approve this node report as ordinary feedback at its level';
export function seasonPayout({ level, codeOnly = false, followUp = false, flags = {}, played = true, receivedMs = null } = {}) {
  const lv = String(level || '').toLowerCase();
  if (lv === 'node' && Number.isFinite(receivedMs) && receivedMs >= NODE_BOT_EXCLUDED_FROM_MS && !(!!played && HUMAN_FLAGS.some((k) => !!(flags && flags[k]))))
    return { ok: false, nodeNotHuman: true, why: NODE_BOT_EXCLUDED_WHY };
  if (lv === 'node') return { ok: true, level: 'node', baseSats: NODE_SATS, bonusPct: 0, sats: NODE_SATS };
  if (!Object.hasOwn(LEVEL_SATS, lv)) return { ok: false, why: 'a level is useful, low, medium, high, critical or node' };
  let base = followUp ? FOLLOW_UP_SATS : LEVEL_SATS[lv];
  const human = HUMAN_FLAGS.some((k) => !!(flags && flags[k]));
  const full = !codeOnly && !!played && human;
  if (!full) base = Math.floor((base * BOT_PCT) / 100);   // a bot's share (kanban #2784: 25 %, the owner 2026-11-15 later: 15 %)
  const pct = bonusPct(flags);
  // `codeOnly` on the answer (and the approval's code_only) says "paid at 25 %": a payable() read again then never rises to the full level
  return { ok: true, level: lv, baseSats: base, bonusPct: pct, sats: Math.floor(base * (100 + pct) / 100), codeOnly: !full, followUp: !!followUp,
    played: !codeOnly && !!played, human, quarter: !full };
}

/** THE SEASON AT A TIME: Season 2 from `startMs` (null: Season 2 until a start is set), then one more each week. */
export function seasonAt(nowMs, startMs = null) {
  if (!Number.isFinite(startMs) || nowMs < startMs) return FIRST_SEASON;
  return FIRST_SEASON + Math.floor((nowMs - startMs) / SEASON_MS);
}
/** The end of a season (= the next one's start), ms; null without a start (kanban #2787: the stage form names it while the pot is used up). */
export function seasonEndMs(season, startMs = null) {
  if (!Number.isFinite(startMs)) return null;
  return startMs + (Number(season) - FIRST_SEASON + 1) * SEASON_MS;
}

export function newLinkCode() {
  const b = randomBytes(8); let s = '';
  for (const x of b) s += CODE_ABC[x % CODE_ABC.length];
  return `BA-${s}`;
}

/** The area an open ticket is listed under on the public open-issues list: a name only, never the ticket's words. */
const AREAS = [
  [/state machine \(([a-z ]+),/i, null],
  [/lightning|lnurl|payout|withdraw|invoice/i, 'Lightning payouts'],
  [/faucet|feedback form|bounty/i, 'Faucet and feedback'],
  [/slash|liquidat|escrow/i, 'Slashing'],
  [/federation|guardian|fedimint|ecash/i, 'Federation'],
  [/reserve/i, 'Reserves'],
  [/settle|musig|attest/i, 'Settlement'],
  [/committee|quorum|census|bond/i, 'Committees and bonds'],
  [/next ?block|truck|tank/i, 'Next Block game'],
  [/up ?\/ ?down|updown/i, 'BTC Up/Down game'],
  [/rock|paper|scissors|rps/i, 'Rock Paper Scissors game'],
  [/page|layout|mobile|button|text/i, 'Website'],
  [/node|seat|installer|updater/i, 'Node software'],
];
export function areaOf(title) {
  const t = String(title || '');
  for (const [re, name] of AREAS) { const m = re.exec(t); if (m) return name || (m[1].trim()[0].toUpperCase() + m[1].trim().slice(1).toLowerCase()); }
  return 'Other';
}
/** THE PUBLIC OPEN-ISSUES LIST from the board's tasks: open bug tickets (tag Bug, or a title naming a Feedback report), grouped by area - ticket numbers only. */
export function openIssueAreas(tasks, { nowMs = Date.now() } = {}) {
  const by = new Map();
  for (const x of tasks || []) {
    if (!x || x.archived || x.status === 'done') continue;
    const tags = Array.isArray(x.tags) ? x.tags : [];
    if (!(tags.includes('Bug') || /feedback #\d+/i.test(String(x.title || '')))) continue;
    const a = areaOf(x.title);
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(`#${Number(x.id)}`);
  }
  const areas = [...by.entries()].map(([area, tickets]) => ({ area, tickets: tickets.sort((p, q) => Number(p.slice(1)) - Number(q.slice(1))) }))
    .sort((p, q) => p.area.localeCompare(q.area));
  return { updated: new Date(nowMs).toISOString(), areas };
}
/** The list as served: only area names (letters, digits, spaces, / and -) and ticket numbers survive, whatever the file holds. */
export function cleanOpenIssues(o) {
  const areas = (o && Array.isArray(o.areas) ? o.areas : []).slice(0, 50).map((x) => ({
    area: String((x && x.area) || '').replace(/[^A-Za-z0-9 /-]/g, '').slice(0, 40),
    tickets: (x && Array.isArray(x.tickets) ? x.tickets : []).map(String).filter((t) => /^#\d{1,6}$/.test(t)).slice(0, 200) })).filter((x) => x.area);
  return { updated: o && typeof o.updated === 'string' ? o.updated.slice(0, 30) : null, areas };
}

// `paidOf(reportId)` (kanban #2784 pot): the sats actually paid for a report (its paid reward), null when not paid - the faucet passes the report
// store's; without it every approval counts by the current rule.
// `pots` (kanban #2784, the owner 2026-11-15: "Season 2 pot = 120,000"): a pot per season, { 2: 120000 }; a season not named has `potSats`.
// `drawPrizes`: the season draw's prize, its own figure beside the pot ({ 2: 50000 }), never counted in it.
export function openBountySeason(path = ':memory:', { startMs = null, potSats = SEASON_POT_SATS, pots = {}, drawPrizes = {}, paidOf = null } = {}) {
  const potOf = (season) => (Number.isInteger(Number(pots && pots[season])) && Number(pots[season]) > 0 ? Number(pots[season]) : potSats);
  const drawPrizeOf = (season) => (Number.isInteger(Number(drawPrizes && drawPrizes[season])) && Number(drawPrizes[season]) > 0 ? Number(drawPrizes[season]) : null);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS link_codes (code TEXT PRIMARY KEY, pubkey TEXT NOT NULL, made_ms INTEGER NOT NULL, used_ms INTEGER, platform TEXT, user_id TEXT);
    CREATE INDEX IF NOT EXISTS link_codes_by_key ON link_codes (pubkey, made_ms);
    CREATE INDEX IF NOT EXISTS link_codes_by_age ON link_codes (made_ms);
    CREATE TABLE IF NOT EXISTS links (pubkey TEXT NOT NULL, platform TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, linked_ms INTEGER NOT NULL,
      member INTEGER, checked_ms INTEGER, why TEXT, PRIMARY KEY (pubkey, platform));
    CREATE UNIQUE INDEX IF NOT EXISTS links_by_account ON links (platform, user_id);
    CREATE TABLE IF NOT EXISTS checks (pubkey TEXT NOT NULL, platform TEXT NOT NULL, user_id TEXT NOT NULL, member INTEGER, at_ms INTEGER NOT NULL, why TEXT, cause TEXT);
    CREATE TABLE IF NOT EXISTS approvals (report TEXT PRIMARY KEY, pubkey TEXT NOT NULL, season INTEGER NOT NULL, level TEXT NOT NULL, code_only INTEGER NOT NULL,
      follow_up INTEGER NOT NULL, base_sats INTEGER NOT NULL, bonus_pct INTEGER NOT NULL, sats INTEGER NOT NULL, state TEXT NOT NULL, flags TEXT, at_ms INTEGER NOT NULL,
      payable_sats INTEGER, payable_ms INTEGER, by TEXT);`);
  const seasonNow = (nowMs) => seasonAt(nowMs, startMs);

  /** A ONE-TIME LINK CODE for a reporter's key (signed in with it): 24 hours, used once, at most LINK_CODES_OPEN_MOST open at a time. */
  function makeCode(pubkey, { nowMs = Date.now() } = {}) {
    if (!/^[0-9a-f]{64}$/.test(String(pubkey))) return { ok: false, why: 'no key' };
    const open = db.prepare('SELECT COUNT(*) AS n FROM link_codes WHERE pubkey = ? AND used_ms IS NULL AND made_ms > ?').get(pubkey, nowMs - LINK_CODE_MS).n;
    if (open >= LINK_CODES_OPEN_MOST) {
      const last = db.prepare('SELECT code, made_ms FROM link_codes WHERE pubkey = ? AND used_ms IS NULL AND made_ms > ? ORDER BY made_ms DESC LIMIT 1').get(pubkey, nowMs - LINK_CODE_MS);
      return { ok: true, code: last.code, expiresMs: last.made_ms + LINK_CODE_MS, again: true };
    }
    // A CODE NOBODY USED IS GONE ONCE IT EXPIRED (kanban #2666, #1489 r2-faucet-1): fresh keys made a row each, kept for good; now the unused
    // expired ones go with each new code (read by link_codes_by_age), and a key's open codes are counted through link_codes_by_key, not a scan
    db.prepare('DELETE FROM link_codes WHERE used_ms IS NULL AND made_ms <= ?').run(nowMs - LINK_CODE_MS);
    const code = newLinkCode();
    db.prepare('INSERT INTO link_codes (code, pubkey, made_ms) VALUES (?, ?, ?)').run(code, pubkey, nowMs);
    return { ok: true, code, expiresMs: nowMs + LINK_CODE_MS };
  }

  /**
   * A CODE POSTED TO A BOT: the platform account (`userId` the platform's stable id, `username` shown on the draw list) is linked to the code's key.
   * One account per key and platform, one key per account (a second key cannot take an account another key holds).
   */
  function redeem(codeText, { platform, userId, username = null, nowMs = Date.now() } = {}) {
    if (!PLATFORMS.includes(platform)) return { ok: false, why: 'no such platform' };
    const m = LINK_CODE_RE.exec(String(codeText || '').toUpperCase());
    if (!m || !userId) return { ok: false, why: 'no code' };
    const code = `BA-${m[1].toUpperCase()}`;
    const c = db.prepare('SELECT * FROM link_codes WHERE code = ?').get(code);
    if (!c) return { ok: false, why: 'unknown code' };
    if (c.used_ms != null) return { ok: false, why: 'that code was used already' };
    if (nowMs - c.made_ms > LINK_CODE_MS) return { ok: false, why: 'that code has expired: make a new one' };
    const held = db.prepare('SELECT pubkey FROM links WHERE platform = ? AND user_id = ?').get(platform, String(userId));
    if (held && held.pubkey !== c.pubkey) return { ok: false, why: 'that account is linked to another report key' };
    db.prepare('UPDATE link_codes SET used_ms = ?, platform = ?, user_id = ? WHERE code = ? AND used_ms IS NULL').run(nowMs, platform, String(userId), code);
    db.prepare(`INSERT INTO links (pubkey, platform, user_id, username, linked_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (pubkey, platform) DO UPDATE SET user_id = excluded.user_id, username = excluded.username, linked_ms = excluded.linked_ms, member = NULL, checked_ms = NULL, why = NULL`)
      .run(c.pubkey, platform, String(userId), username ? String(username).slice(0, 64) : null, nowMs);
    return { ok: true, pubkey: c.pubkey, platform };
  }

  const linkRow = (x) => ({ platform: x.platform, userId: x.user_id, username: x.username, linkedMs: x.linked_ms, member: x.member == null ? null : !!x.member, checkedMs: x.checked_ms, why: x.why });
  const linksOf = (pubkey) => db.prepare('SELECT * FROM links WHERE pubkey = ? ORDER BY platform').all(String(pubkey)).map(linkRow);

  /** A MEMBERSHIP READ, stored on the link with its time (and kept in `checks`). */
  function record(pubkey, platform, { member, why = null, cause = 'verify', nowMs = Date.now() } = {}) {
    const l = db.prepare('SELECT * FROM links WHERE pubkey = ? AND platform = ?').get(String(pubkey), platform);
    if (!l) return { ok: false, why: 'not linked' };
    const m = member === true ? 1 : member === false ? 0 : null;
    db.prepare('UPDATE links SET member = ?, checked_ms = ?, why = ? WHERE pubkey = ? AND platform = ?').run(m, nowMs, why, l.pubkey, platform);
    db.prepare('INSERT INTO checks (pubkey, platform, user_id, member, at_ms, why, cause) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.pubkey, platform, l.user_id, m, nowMs, why, cause);
    return { ok: true };
  }

  /**
   * READ EVERY LINK OF A KEY LIVE (`verifiers[platform](link) -> { member: bool, why? }`) and store each answer. A verifier that throws stores no
   * member (null): no bonus on a read that did not happen. A platform with no verifier given is not read (its stored read stands, and ages out).
   */
  async function verify(pubkey, verifiers = {}, { cause = 'verify', nowMs = () => Date.now() } = {}) {
    for (const l of linksOf(pubkey)) {
      const f = verifiers[l.platform];
      if (!f) continue;
      let r;
      try { r = await f(l); } catch (e) { r = { member: null, why: String((e && e.message) || e).slice(0, 120) }; }
      record(pubkey, l.platform, { member: r && r.member, why: (r && r.why) || null, cause, nowMs: nowMs() });
    }
    return flagsOf(pubkey, { nowMs: nowMs() });
  }

  /** THE STORED FLAGS of a key: a platform counts when its last read said member and is fresh (CHECK_FRESH_MS). */
  function flagsOf(pubkey, { nowMs = Date.now() } = {}) {
    const f = { telegram: false, discord: false, x: false };
    for (const l of linksOf(pubkey)) if (l.member === true && l.checkedMs != null && nowMs - l.checkedMs <= CHECK_FRESH_MS) f[l.platform] = true;
    return f;
  }

  function pot(season) {
    const s = Number(season);
    // WHAT THE POT HAS REALLY GIVEN (kanban #2784, the owner 2026-11-15): an approval counts what was paid for it, else what it pays now under the
    // current rule (seasonPayout from its stored level, code-only, follow-up and flags; never above its stored amount). The stored amount alone
    // kept the old 50 % approvals at 50 % after they were paid at 25 %: 11,750 used where 5,875 was paid or payable.
    let used = 0;
    for (const a of db.prepare(`SELECT * FROM approvals WHERE season = ? AND state = 'approved'`).all(s)) {
      const paid = typeof paidOf === 'function' ? paidOf(a.report) : null;
      if (Number.isInteger(paid) && paid >= 0) { used += paid; continue; }
      const now = seasonPayout({ level: a.level, codeOnly: !!a.code_only, followUp: !!a.follow_up, flags: a.level === 'node' ? {} : JSON.parse(a.flags || '{}') });
      used += now.ok ? Math.min(now.sats, a.sats) : a.sats;
    }
    const waiting = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(sats), 0) AS s FROM approvals WHERE state = 'waiting'`).get();
    const nodes = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE season = ? AND state = 'approved' AND level = 'node'`).get(s).n;
    const pot = potOf(s);
    return { season: s, potSats: pot, usedSats: used, leftSats: pot - used, drawPrizeSats: drawPrizeOf(s), nodes, nodesMost: NODES_PER_SEASON, waiting: { n: waiting.n, sats: waiting.s } };
  }

  /**
   * THE SEASON'S PART OF AN APPROVAL, before the report store's own approve(): the payout by the rules and the stored flags, held to the season's pot.
   * Answers { ok, fits: true, sats, ... } to approve now, { ok, fits: false, waits: true } when the pot cannot take it (recorded as waiting for the
   * next season; the report stays unapproved), or { ok: false, why }. commit() records an approval the store took.
   */
  function plan(report, { level, codeOnly = false, followUp = false, played = true, nowMs = Date.now() } = {}) {
    if (!report || !report.id) return { ok: false, why: 'no such report' };
    const had = db.prepare('SELECT * FROM approvals WHERE report = ?').get(report.id);
    if (had && had.state === 'approved') return { ok: false, why: 'that report has its Season 2 approval' };
    const isNode = String(level).toLowerCase() === 'node';
    // kanban #2876: a node report received from NODE_BOT_EXCLUDED_FROM_MS is read against its reporter's flags too (proven human or not)
    const rec = Number(report.receivedMs);
    const nodeRule = isNode && Number.isFinite(rec) && rec >= NODE_BOT_EXCLUDED_FROM_MS;
    if (nodeRule) { const n = seasonPayout({ level, flags: flagsOf(report.pubkey, { nowMs }), played, receivedMs: rec }); if (!n.ok) return n; }
    const flags = isNode ? {} : flagsOf(report.pubkey, { nowMs });
    const p = seasonPayout({ level, codeOnly, followUp, flags, played });
    if (!p.ok) return p;
    const season = seasonNow(nowMs);
    const now = pot(season);
    if (p.level === 'node' && now.nodes >= NODES_PER_SEASON) return { ok: false, why: `the node bounty is for the first ${NODES_PER_SEASON} nodes of a season: all are taken in Season ${season}` };
    const fits = p.sats <= now.leftSats;
    // NO CARRY-OVER (kanban #2787, the owner 2026-11-15; from Season 2 on: "wenn der Pot voll ist, ist er voll"): once a season's pot is used up there is no bounty - the report does not
    // wait for the next season (Season 2 first let it wait for Season 3).
    if (!fits && season >= NO_CARRY_FROM_SEASON) return { ok: true, fits: false, waits: false, noBounty: true, season, flags, ...p, pot: now,
      why: `Season ${season}'s pot is used up (${now.leftSats} sat left, this report is ${p.sats}): no bounty` };
    return { ok: true, fits, waits: !fits, season, flags, ...p, pot: now };
  }
  function keep(report, p, state, { by = null, nowMs = Date.now() } = {}) {
    db.prepare(`INSERT INTO approvals (report, pubkey, season, level, code_only, follow_up, base_sats, bonus_pct, sats, state, flags, at_ms, by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (report) DO UPDATE SET season = excluded.season, level = excluded.level, code_only = excluded.code_only,
      follow_up = excluded.follow_up, base_sats = excluded.base_sats, bonus_pct = excluded.bonus_pct, sats = excluded.sats, state = excluded.state, flags = excluded.flags,
      at_ms = excluded.at_ms, by = excluded.by`)
      .run(report.id, report.pubkey, p.season, p.level, p.codeOnly ? 1 : 0, p.followUp ? 1 : 0, p.baseSats, p.bonusPct, p.sats, state, JSON.stringify(p.flags || {}), nowMs, by);
    return approval(report.id);
  }
  const commit = (report, p, o) => keep(report, p, 'approved', o);
  const wait = (report, p, o) => keep(report, p, 'waiting', o);

  const approvalRow = (x) => (x ? { report: x.report, pubkey: x.pubkey, season: x.season, level: x.level, codeOnly: !!x.code_only, followUp: !!x.follow_up,
    baseSats: x.base_sats, bonusPct: x.bonus_pct, sats: x.sats, state: x.state, flags: JSON.parse(x.flags || '{}'), atMs: x.at_ms,
    payableSats: x.payable_sats, payableMs: x.payable_ms } : null);
  const approval = (id) => approvalRow(db.prepare('SELECT * FROM approvals WHERE report = ?').get(String(id)));
  const approvals = ({ season = null, state = null } = {}) => db.prepare(`SELECT * FROM approvals WHERE (? IS NULL OR season = ?) AND (? IS NULL OR state = ?) ORDER BY at_ms`)
    .all(season, season, state, state).map(approvalRow);

  /**
   * BEFORE PAYOUT: the bonus read again from flags just verified. The payable amount never rises above the approved one (a bonus lost since is taken
   * off; one gained since waits for the next report). Stored on the approval with its time; nothing is paid here.
   */
  function payable(id, { nowMs = Date.now() } = {}) {
    const a = approval(id);
    if (!a || a.state !== 'approved') return { ok: false, why: 'no Season 2 approval for that report' };
    const p = seasonPayout({ level: a.level, codeOnly: a.codeOnly, followUp: a.followUp, flags: a.level === 'node' ? {} : flagsOf(a.pubkey, { nowMs }) });
    const sats = Math.min(p.sats, a.sats);
    db.prepare('UPDATE approvals SET payable_sats = ?, payable_ms = ? WHERE report = ?').run(sats, nowMs, a.report);
    return { ok: true, report: a.report, approvedSats: a.sats, payableSats: sats, bonusPct: Math.min(p.bonusPct, a.bonusPct), flags: flagsOf(a.pubkey, { nowMs }) };
  }

  /**
   * THE DRAW'S ENTRIES for a season: every key with an approved report in it that is a Telegram or Discord member (fresh read) - one entry per person,
   * named by its platform username (telegram first). Call after verify() for each key (membership is read again right before the draw).
   */
  function drawEntries(season, { nowMs = Date.now() } = {}) {
    const keys = db.prepare(`SELECT DISTINCT pubkey FROM approvals WHERE season = ? AND state = 'approved' AND level <> 'node'`).all(Number(season)).map((x) => x.pubkey);
    const picks = [];
    for (const k of keys) {
      const f = flagsOf(k, { nowMs });
      const ls = linksOf(k);
      const pick = (f.telegram && ls.find((l) => l.platform === 'telegram')) || (f.discord && ls.find((l) => l.platform === 'discord')) || null;
      if (pick) picks.push({ name: `${pick.platform}:${pick.username || pick.userId}`, id: `${pick.platform}:${pick.userId || k}`, key: k });
    }
    // ONE ENTRY PER KEY, NEVER MERGED BY A NAME (kanban #2684, #1489 r3-faucet-2): a username is text another account can show too (an old link
    // under a Telegram first name, a name given up and taken), and two keys under one name collapsed into ONE entry here and in bounty-draw.mjs -
    // the honest reporter's place was gone. A name two keys share is told apart by the account id behind it (`#<id>`, which nobody chooses).
    const count = new Map(); for (const x of picks) count.set(x.name, (count.get(x.name) || 0) + 1);
    const out = picks.map((x) => (count.get(x.name) > 1 ? `${x.name}#${x.id.slice(x.id.indexOf(':') + 1)}` : x.name));
    return [...new Set(out)].sort();
  }
  const keysOfSeason = (season) => db.prepare(`SELECT DISTINCT pubkey FROM approvals WHERE season = ? AND state = 'approved'`).all(Number(season)).map((x) => x.pubkey);
  // THE OWNER'S "REAL USER" MARK (kanban #2875, the owner 2026-11-16): per reporter key, the player's name, who set it and when - shown on every
  // report of that key in the admin page; it changes no payout share (that would be asked first). Cleared marks stay as rows with cleared_ms.
  db.exec('CREATE TABLE IF NOT EXISTS real_users (pubkey TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, set_by TEXT, set_ms INTEGER NOT NULL, cleared_ms INTEGER, cleared_by TEXT)');
  const realUserOf = (pubkey) => { const r = db.prepare('SELECT * FROM real_users WHERE pubkey = ? AND cleared_ms IS NULL').get(String(pubkey).toLowerCase());
    return r ? { pubkey: r.pubkey, name: r.name, note: r.note || null, setBy: r.set_by || null, setMs: Number(r.set_ms) } : null; };
  const markRealUser = (pubkey, { name, note = null, by = null, nowMs = Date.now() } = {}) => {
    const k = String(pubkey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(k)) return { ok: false, why: 'a reporter key is 64 hex' };
    const n = String(name || '').trim();
    if (!n || n.length > 80) return { ok: false, why: 'name the player (1-80 characters)' };
    db.prepare('INSERT OR REPLACE INTO real_users (pubkey, name, note, set_by, set_ms, cleared_ms, cleared_by) VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(k, n, note ? String(note).slice(0, 200) : null, by ? String(by).slice(0, 80) : null, nowMs);
    return { ok: true, realUser: realUserOf(k) };
  };
  // THE OWNER'S "PLAYED" MARK PER REPORT (kanban #2875, the owner 2026-11-16: "da wo er Fehler gefunden hat, die die Runde betreffen, hat er sie gespielt,
  // trage das ein"): a report the owner says was found while playing counts as played for the Season 2 amount, whatever the network check says
  db.exec('CREATE TABLE IF NOT EXISTS played_marks (report TEXT PRIMARY KEY, set_by TEXT, set_ms INTEGER NOT NULL, cleared_ms INTEGER, cleared_by TEXT)');
  const playedMarkOf = (report) => { const r = db.prepare('SELECT * FROM played_marks WHERE report = ? AND cleared_ms IS NULL').get(String(report));
    return r ? { setBy: r.set_by || null, setMs: Number(r.set_ms) } : null; };
  const markPlayed = (report, { by = null, nowMs = Date.now() } = {}) => {
    if (!/^[0-9a-f]{64}$/i.test(String(report || ''))) return { ok: false, why: 'a report id is 64 hex' };
    db.prepare('INSERT OR REPLACE INTO played_marks (report, set_by, set_ms, cleared_ms, cleared_by) VALUES (?, ?, ?, NULL, NULL)').run(String(report).toLowerCase(), by ? String(by).slice(0, 80) : null, nowMs);
    return { ok: true, played: playedMarkOf(String(report).toLowerCase()) };
  };
  const clearPlayed = (report, { by = null, nowMs = Date.now() } = {}) => {
    const c = db.prepare('UPDATE played_marks SET cleared_ms = ?, cleared_by = ? WHERE report = ? AND cleared_ms IS NULL').run(nowMs, by ? String(by).slice(0, 80) : null, String(report).toLowerCase()).changes;
    return c ? { ok: true } : { ok: false, why: 'that report carries no played mark' };
  };
  const clearRealUser = (pubkey, { by = null, nowMs = Date.now() } = {}) => {
    const k = String(pubkey || '').toLowerCase();
    const c = db.prepare('UPDATE real_users SET cleared_ms = ?, cleared_by = ? WHERE pubkey = ? AND cleared_ms IS NULL').run(nowMs, by ? String(by).slice(0, 80) : null, k).changes;
    return c ? { ok: true } : { ok: false, why: 'that key carries no real-user mark' };
  };


  return { makeCode, redeem, links: linksOf, record, verify, flagsOf, pot, plan, commit, wait, approval, approvals, payable, drawEntries, keysOfSeason,
    seasonNow, realUserOf, markRealUser, clearRealUser, playedMarkOf, markPlayed, clearPlayed, close: () => db.close() };
}
