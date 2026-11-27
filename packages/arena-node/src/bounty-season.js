// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BUG BOUNTY SEASON 2 (kanban #2623, the rules page testnet-stage.bitcoinarena.io/bounty/): a pot of 100,000 sat per one-week season for confirmed
// reports, community bonuses and node bounties; a community bonus from linked X / Telegram / Discord / Armada accounts (Week 2 rule, kanban #2641); code-only findings at half; follow-ups
// at 1,000; the node bounty for the first 3 nodes of a season. Its own file (FAUCET_BOUNTY_S2_DB), so Season 1's feedback.db keeps its schema.
// This module only computes and records: paying stays the separate manual step it was (it never calls a wallet).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';   // kanban #2958: the bot handle list

export const SEASON_POT_SATS = 100000;
export const SEASON_MS = 7 * 24 * 3600 * 1000;
export const NO_CARRY_FROM_SEASON = 2;   // kanban #2787 (the owner 2026-11-15: "wenn der Pot voll ist, ist er voll"): from Season 2 on a used-up pot means no bounty, nothing waits
export const FIRST_SEASON = 2;
export const FOLLOW_UP_SATS = 1000;
export const NODE_SATS = 10000;
export const NODES_PER_SEASON = 3;
export const LEVEL_SATS = Object.freeze({ useful: 500, low: 1000, medium: 2000, high: 5000, critical: 10000 });
export const PLATFORMS = Object.freeze(['telegram', 'discord', 'x', 'armada', 'nostr']);
/** WEEK 2 (kanban #2641): the communities the second bonus counts - any 2 of these 3 */
export const COMMUNITIES = Object.freeze(['telegram', 'discord', 'armada']);
export const X_BONUS_PCT = 20;
export const COMMUNITY_BONUS_PCT = 20;
export const COMMUNITY_LEAST = 2;
/** A NOSTR FOLLOW (kanban #2641, the owner 2026-11-14: "Twitter +20%, Nostr +20%, und dann 2 of 3 ist nochmal +20%, gesamt +60% maximal"). */
export const NOSTR_BONUS_PCT = 20;
export const LINK_CODE_MS = 24 * 3600 * 1000;
export const LINK_CODES_OPEN_MOST = 5;
/** A membership read longer ago than this does not count for a bonus or the draw: it is read again first. */
export const CHECK_FRESH_MS = 24 * 3600 * 1000;
// the code a reporter posts: "BA-" and 8 letters/digits without look-alikes (no 0/O, 1/I/L)
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LINK_CODE_RE = /\bBA-([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/i;

/**
 * THE BONUS IN PERCENT from the stored flags (Season 2, the owner 2026-11-14, kanban #2641: "Twitter +20%, Nostr +20%, und dann 2 of 3 ist nochmal +20%,
 * gesamt +60% maximal"): X follower +20; Nostr follower +20; a member of at least 2 of Telegram, Discord and Armada +20; at most +60. All optional.
 */
export function bonusPct(flags = {}) {
  const n = COMMUNITIES.filter((p) => flags[p] === true).length;
  return (flags.x === true ? X_BONUS_PCT : 0) + (n >= COMMUNITY_LEAST ? COMMUNITY_BONUS_PCT : 0) + (flags.nostr === true ? NOSTR_BONUS_PCT : 0);
}

/**
 * WHAT ONE APPROVAL PAYS, by the Season 2 rules: the level's sats (a follow-up 1,000) in full only when the reporter played a round AND is proven
 * human - a linked X (Twitter) account (kanban #2788, the owner 2026-11-15: "Um human zu beweisen benoetigen wir einen Twitter"; Telegram,
 * Discord and Armada no longer prove it, they stay a bonus); everything else - a code-only finding (no played round) or a player with no verified X
 * account (counts as a bot) - pays BOT_PCT, 15 % (kanban #2784; 25 % until the owner's 15 % later that day; code-only was half). Then the community bonus on top. A node bounty is 10,000 flat (it is not a
 * report: no bonus, no half).
 */
// WHAT A BOT GETS (kanban #2784, the owner 2026-11-15: "Setze die Bot-Bounties nur auf 15 % jetzt"): the share of the level for everything that is not a
// played round by a verified X account (was 25 %)
export const BOT_PCT = 15;
export const HUMAN_FLAGS = Object.freeze(['x']);
// NO NODE BOUNTY FOR A BOT (kanban #2876, the owner 2026-11-16 ~07:06Z: "Ab sofort, mit Timestamp jetzt in der Bounty definieren: Bots sind ausgenommen von
// dem 10k sat Bonus, es zaehlt nur das eigentliche Feedback"): a node report received from 2026-11-16T07:06:38Z on whose reporter is not proven human (a
// played round - the owner's played mark counts - AND a verified X account) gets no flat node bounty; it is approved as ordinary feedback at its level
// (the bot share, the bonus as usual). A report received before keeps the old rule.
export const NODE_BOT_EXCLUDED_FROM_MS = 1794812798412;
export const NODE_BOT_EXCLUDED_WHY = 'From 16 Nov 2026 07:06 UTC the 10,000 sat node bounty is only for humans with a linked X account: approve this node report as ordinary feedback at its level';
export function seasonPayout({ level, codeOnly = false, followUp = false, flags = {}, played = true, receivedMs = null } = {}) {
  const lv = String(level || '').toLowerCase();
  if (lv === 'node' && Number.isFinite(receivedMs) && receivedMs >= NODE_BOT_EXCLUDED_FROM_MS && !HUMAN_FLAGS.some((k) => !!(flags && flags[k])))   // the owner 2026-11-16 ~14:00Z: no played round needed (a node session cannot play) - a linked X only
    return { ok: false, nodeNotHuman: true, why: NODE_BOT_EXCLUDED_WHY };
  if (lv === 'node') return { ok: true, level: 'node', baseSats: NODE_SATS, bonusPct: 0, sats: NODE_SATS };
  if (!Object.hasOwn(LEVEL_SATS, lv)) return { ok: false, why: 'a level is useful, low, medium, high, critical or node' };
  let base = followUp ? FOLLOW_UP_SATS : LEVEL_SATS[lv];
  const human = HUMAN_FLAGS.some((k) => !!(flags && flags[k])) || !!(flags && flags.realUser);   // owner 2026-11-23: a reporter the owner marked real (admin real-user) is human
  const full = !codeOnly && human;   // the owner 2026-11-16 ~14:10Z: "Ein bestaetigtes X-Konto reicht" - a verified X makes a human; a played round is no longer needed
  if (!full) base = Math.floor((base * BOT_PCT) / 100);   // a bot's share (kanban #2784: 25 %, the owner 2026-11-15 later: 15 %)
  const pct = human ? bonusPct(flags) : 0;   // the owner 2026-11-16: the social bonus is for humans only (a verified X); a bot gets its 15 % and no bonus
  // `codeOnly` on the answer (and the approval's code_only) says "paid at the bot share": a payable() read again then never rises to the full level
  return { ok: true, level: lv, baseSats: base, bonusPct: pct, sats: Math.floor(base * (100 + pct) / 100), codeOnly: !full, followUp: !!followUp,
    played: !codeOnly && !!played, human, quarter: !full };
}

/** THE SEASON AT A TIME: Season 2 from `startMs` (null: Season 2 until a start is set), then one more each week. */
// `s2EndMs` (kanban #2784, the owner 2026-11-15: Season 2 public, ends 2026-11-22 17:00:00Z): Season 2 runs from `startMs` to it, the seasons after
// one week each from there; without it every season is one week from `startMs`.
export function seasonAt(nowMs, startMs = null, s2EndMs = null) {
  if (!Number.isFinite(startMs) || nowMs < startMs) return FIRST_SEASON;
  if (Number.isFinite(s2EndMs)) return nowMs < s2EndMs ? FIRST_SEASON : FIRST_SEASON + 1 + Math.floor((nowMs - s2EndMs) / SEASON_MS);
  return FIRST_SEASON + Math.floor((nowMs - startMs) / SEASON_MS);
}

/** WHEN A WEEK ENDS (kanban #2641): its start + 7 days; Week 2 starts at `startMs`. null without a start. */
export function seasonEndMs(season, startMs = null, s2EndMs = null) {
  if (!Number.isFinite(startMs)) return null;
  if (Number.isFinite(s2EndMs)) return Number(season) < FIRST_SEASON ? startMs : s2EndMs + (Number(season) - FIRST_SEASON) * SEASON_MS;
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
/**
 * THE PUBLIC OPEN-ISSUES LIST from the board's tasks: open bug tickets (tag Bug, a title naming a Feedback report) and our own security audit cards
 * ("Audit [...]", state-machine, attack/bypass/refute findings - the owner 2026-11-14, kanban #2641: "da fehlen unsere ganzen Security-Audits"), grouped
 * by area - ticket numbers only, never a title.
 */
/**
 * A PUBLIC BUG (the owner 2026-11-14, kanban #2641: "Nur Tickets anzeigen, die Bugs sind, und keine Feature Requests"): open (not done, not parked in
 * backlog) and a bug - its title starts "Audit [", "Fix does not hold", "State audit", "Regression:" or "Feedback #", it carries the Bug tag, or the
 * reviewed summary map marks it kind "bug". Features, builds, releases and ops never.
 */
export const BUG_TITLE = /^(Audit \[|Fix does not hold|State audit|Regression:|Feedback #)/i;
const summaryOf = (summaries, id) => { const v = summaries && summaries[String(id)]; return v == null ? null : typeof v === 'string' ? { text: v, kind: null } : { text: v.text || null, kind: v.kind || null }; };
export function isPublicBug(x, summaries = {}) {
  if (!x || x.archived || x.status === 'done' || x.status === 'backlog') return false;
  const sm = summaryOf(summaries, x.id);
  if (sm && sm.kind && sm.kind !== 'bug') return false;
  const tags = Array.isArray(x.tags) ? x.tags : [];
  return tags.includes('Bug') || BUG_TITLE.test(String(x.title || '')) || !!(sm && sm.kind === 'bug');
}
/** ONE LINE PER TICKET: the reviewed summary, or "<area>: issue under review" - never the ticket's own title. */
const SAFE_LINE = (t) => String(t || '').replace(/[^A-Za-z0-9 ,.:;'()/+%-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
/**
 * THE PUBLIC OPEN-ISSUES LIST from the board's tasks: open public bugs (isPublicBug), grouped by area, each with its ticket number and its one-line
 * summary from `summaries` (kanban #2641) - never a title. `missing` lists the ids that still need a summary.
 */
export function openIssueAreas(tasks, { nowMs = Date.now(), summaries = {} } = {}) {
  const by = new Map(), missing = [];
  for (const x of tasks || []) {
    if (!isPublicBug(x, summaries)) continue;
    const a = areaOf(x.title), sm = summaryOf(summaries, x.id);
    if (!sm || !sm.text) missing.push(Number(x.id));
    if (!by.has(a)) by.set(a, []);
    by.get(a).push({ id: `#${Number(x.id)}`, text: SAFE_LINE(sm && sm.text) || `${a}: issue under review` });
  }
  const areas = [...by.entries()].map(([area, items]) => { items.sort((p, q) => Number(p.id.slice(1)) - Number(q.id.slice(1)));
    return { area, tickets: items.map((x) => x.id), items }; }).sort((p, q) => p.area.localeCompare(q.area));
  return { updated: new Date(nowMs).toISOString(), areas, missing: missing.sort((p, q) => p - q) };
}
/** The list as served: area names, ticket numbers and the one-line summaries (letters, digits, plain punctuation), whatever the file holds. */
export function cleanOpenIssues(o) {
  const areas = (o && Array.isArray(o.areas) ? o.areas : []).slice(0, 50).map((x) => {
    const area = String((x && x.area) || '').replace(/[^A-Za-z0-9 /-]/g, '').slice(0, 40);
    const tickets = (x && Array.isArray(x.tickets) ? x.tickets : []).map(String).filter((t) => /^#\d{1,6}$/.test(t)).slice(0, 200);
    const items = (x && Array.isArray(x.items) ? x.items : []).filter((i) => i && /^#\d{1,6}$/.test(String(i.id))).slice(0, 200).map((i) => ({ id: String(i.id), text: SAFE_LINE(i.text) || `${area}: issue under review` }));
    return { area, tickets, items }; }).filter((x) => x.area);
  return { updated: o && typeof o.updated === 'string' ? o.updated.slice(0, 30) : null, areas };
}

// `paidOf(reportId)` (kanban #2784 pot): the sats actually paid for a report (its paid reward), null when not paid - the faucet passes the report
// store's; without it every approval counts by the current rule.
// `pots` (kanban #2784, the owner 2026-11-15: "Season 2 pot = 120,000"): a pot per season, { 2: 120000 }; a season not named has `potSats`.
// `drawPrizes`: the season draw's prize, its own figure beside the pot ({ 2: 50000 }), never counted in it.
export function openBountySeason(path = ':memory:', { startMs = null, s2EndMs = null, potSats = SEASON_POT_SATS, pots = {}, drawPrizes = {}, paidOf = null } = {}) {
  const potOf = (season) => (Number.isInteger(Number(pots && pots[season])) && Number(pots[season]) > 0 ? Number(pots[season]) : potSats);
  const drawPrizeOf = (season) => (Number.isInteger(Number(drawPrizes && drawPrizes[season])) && Number(drawPrizes[season]) > 0 ? Number(drawPrizes[season]) : null);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS link_codes (code TEXT PRIMARY KEY, pubkey TEXT NOT NULL, made_ms INTEGER NOT NULL, used_ms INTEGER, platform TEXT, user_id TEXT);
    CREATE INDEX IF NOT EXISTS link_codes_by_key ON link_codes (pubkey, made_ms);
    CREATE INDEX IF NOT EXISTS link_codes_by_age ON link_codes (made_ms);
    CREATE TABLE IF NOT EXISTS link_code_uses (code TEXT NOT NULL, platform TEXT NOT NULL, used_ms INTEGER NOT NULL, user_id TEXT, PRIMARY KEY (code, platform));
    INSERT OR IGNORE INTO link_code_uses (code, platform, used_ms, user_id) SELECT code, platform, used_ms, user_id FROM link_codes WHERE used_ms IS NOT NULL AND platform IS NOT NULL;
    CREATE TABLE IF NOT EXISTS links (pubkey TEXT NOT NULL, platform TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, linked_ms INTEGER NOT NULL,
      member INTEGER, checked_ms INTEGER, why TEXT, PRIMARY KEY (pubkey, platform));
    CREATE TABLE IF NOT EXISTS tg_seen (username TEXT PRIMARY KEY, user_id TEXT NOT NULL, seen_ms INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS links_by_account ON links (platform, user_id);
    CREATE TABLE IF NOT EXISTS checks (pubkey TEXT NOT NULL, platform TEXT NOT NULL, user_id TEXT NOT NULL, member INTEGER, at_ms INTEGER NOT NULL, why TEXT, cause TEXT);
    CREATE TABLE IF NOT EXISTS approvals (report TEXT PRIMARY KEY, pubkey TEXT NOT NULL, season INTEGER NOT NULL, level TEXT NOT NULL, code_only INTEGER NOT NULL,
      follow_up INTEGER NOT NULL, base_sats INTEGER NOT NULL, bonus_pct INTEGER NOT NULL, sats INTEGER NOT NULL, state TEXT NOT NULL, flags TEXT, at_ms INTEGER NOT NULL,
      payable_sats INTEGER, payable_ms INTEGER, by TEXT);`);
  // HOW A LINK WAS MADE (kanban #2641): 'code' (a one-time code posted from the account - proven) or 'name' (a username typed in the form and found live)
  try { db.exec("ALTER TABLE links ADD COLUMN proof TEXT NOT NULL DEFAULT 'code'"); } catch { /* there already */ }
  // WHY A PAYOUT WENT DOWN (kanban #2641), e.g. "left Discord: -25 %"
  try { db.exec('ALTER TABLE approvals ADD COLUMN payable_why TEXT'); } catch { /* there already */ }
  // THE ROW BEFORE AN INTENT (kanban #3220): an 'approving' row keeps the row it replaced (JSON, null when there was none), so a report store that
  // refuses the approval puts that row back - a waiting report keeps waiting
  try { db.exec('ALTER TABLE approvals ADD COLUMN intent_prior TEXT'); } catch { /* there already */ }
  // EVERY NAME A LINKED ACCOUNT CARRIED (kanban #3032, audit faucet r3-1): the bot list (#2958) was matched against the link's current username only,
  // so a listed X bot renamed its account (free on X), typed or posted the new name, and its reports paid the human amount again. Each
  // (platform, account id, name) a link ever held is kept, and the list is matched against all of an account's names
  db.exec(`CREATE TABLE IF NOT EXISTS link_names (platform TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY (platform, user_id, username));
    INSERT OR IGNORE INTO link_names (platform, user_id, username) SELECT platform, user_id, lower(username) FROM links WHERE username IS NOT NULL;
    DROP TRIGGER IF EXISTS link_names_add; DROP TRIGGER IF EXISTS link_names_move;
    CREATE TRIGGER link_names_add AFTER INSERT ON links WHEN new.username IS NOT NULL BEGIN
      INSERT INTO link_names (platform, user_id, username) SELECT new.platform, new.user_id, lower(new.username)
        WHERE NOT EXISTS (SELECT 1 FROM link_names WHERE platform = new.platform AND user_id = new.user_id AND username = lower(new.username)); END;
    CREATE TRIGGER link_names_move AFTER UPDATE OF username, user_id ON links WHEN new.username IS NOT NULL BEGIN
      INSERT INTO link_names (platform, user_id, username) SELECT new.platform, new.user_id, lower(new.username)
        WHERE NOT EXISTS (SELECT 1 FROM link_names WHERE platform = new.platform AND user_id = new.user_id AND username = lower(new.username)); END;`);
  // NO CONFLICT IN THE TRIGGER (kanban #2645): an upsert's ON CONFLICT DO UPDATE overrides a trigger's OR IGNORE, so a key that typed its account's
  // name and then posted its link code from that account threw "UNIQUE constraint failed: link_names..." in redeem - the code proof never landed
  const namesOf = db.prepare('SELECT username FROM link_names WHERE platform = ? AND user_id = ?');
  const firstNameOf = db.prepare('SELECT username FROM link_names WHERE platform = ? AND user_id = ? ORDER BY rowid ASC LIMIT 1');   // kanban #3056
  const seasonNow = (nowMs) => seasonAt(nowMs, startMs, s2EndMs);

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
    // ONCE PER PLATFORM (kanban #3027, audit faucet r2-1): one use for all platforms let a stranger who read a reporter's code on X send it to the
    // Discord or Telegram bot before the next 3-minute X poll - the code was used up there and the reporter's X account (Season 2's only human
    // proof) could never be linked by code. A code links one account per platform now; on X the first poster of it still wins (#3003)
    if (db.prepare('SELECT 1 AS x FROM link_code_uses WHERE code = ? AND platform = ?').get(code, platform)) return { ok: false, why: 'that code was used already' };
    if (nowMs - c.made_ms > LINK_CODE_MS) return { ok: false, why: 'that code has expired: make a new one' };
    const held = db.prepare('SELECT pubkey, proof FROM links WHERE platform = ? AND user_id = ?').get(platform, String(userId));
    if (held && held.pubkey !== c.pubkey && held.proof === 'code') return { ok: false, why: 'that account is linked to another report key' };
    // A USED CODE NEVER REPLACES A PROVEN LINK (kanban #3349, audit faucet a6-1-1, gap in #3027): a code is public once it was used (an X code is
    // posted on X), and since #3027 it stays good on the other platforms for 24 h - a stranger DMed it to the Discord or Telegram bot and his
    // account replaced the reporter's own code-proven member link (the community bonus lost at payout). A code already used on one platform
    // may still link another platform the key has no code-proven account on, but never moves an existing one; a fresh code still does
    const had = db.prepare('SELECT user_id, proof FROM links WHERE pubkey = ? AND platform = ?').get(c.pubkey, platform);
    if (had && had.proof === 'code' && had.user_id !== String(userId) && db.prepare('SELECT 1 AS x FROM link_code_uses WHERE code = ?').get(code)) {
      return { ok: false, why: 'that code was used already: make a new one in My feedback' };
    }
    // a code proves the account: a key that only typed its name in the form (kanban #2641) gives it up
    if (held && held.pubkey !== c.pubkey) db.prepare('DELETE FROM links WHERE platform = ? AND user_id = ?').run(platform, String(userId));
    db.prepare('UPDATE link_codes SET used_ms = ?, platform = ?, user_id = ? WHERE code = ? AND used_ms IS NULL').run(nowMs, platform, String(userId), code);
    db.prepare('INSERT OR IGNORE INTO link_code_uses (code, platform, used_ms, user_id) VALUES (?, ?, ?, ?)').run(code, platform, nowMs, String(userId));
    db.prepare(`INSERT INTO links (pubkey, platform, user_id, username, linked_ms, proof) VALUES (?, ?, ?, ?, ?, 'code')
      ON CONFLICT (pubkey, platform) DO UPDATE SET user_id = excluded.user_id, username = excluded.username, linked_ms = excluded.linked_ms, member = NULL, checked_ms = NULL, why = NULL, proof = 'code'`)
      .run(c.pubkey, platform, String(userId), username ? String(username).slice(0, 64) : null, nowMs);
    return { ok: true, pubkey: c.pubkey, platform };
  }

  /**
   * A USERNAME TYPED IN THE FORM (Week 2, kanban #2641: "der User gibt jeweils seine usernames dafür an und prüft live"), found live as the account
   * `userId`: linked to the signed-in key. One key per account: an account another key holds is refused (and a code posted from the account takes it
   * from a key that only typed its name). A key's earlier account on the platform is replaced.
   */
  function claimName(pubkey, platform, { userId, username = null, nowMs = Date.now() } = {}) {
    if (!/^[0-9a-f]{64}$/.test(String(pubkey))) return { ok: false, why: 'no key' };
    if (!PLATFORMS.includes(platform)) return { ok: false, why: 'no such platform' };
    if (!userId) return { ok: false, why: 'no account' };
    const held = db.prepare('SELECT pubkey FROM links WHERE platform = ? AND user_id = ?').get(platform, String(userId));
    // A REPORT KEY'S OWN NOSTR KEY IS ITS OWNER'S (kanban #3858, audit r30-nostr-1): a Nostr account (nostr, armada) is a key, and the signed-in
    // report key proves itself on every request. A stranger who typed an honest reporter's public report key first held that account here, and the
    // owner's own link was refused for good (his Nostr +20 % lost on every report). A claim of the signed-in key itself takes the account from
    // whichever other key holds it; any other claim is refused as before
    const ownKey = (platform === 'nostr' || platform === 'armada') && String(userId).toLowerCase() === String(pubkey).toLowerCase();
    if (held && held.pubkey !== pubkey && ownKey) db.prepare('DELETE FROM links WHERE platform = ? AND user_id = ?').run(platform, String(userId));
    else if (held && held.pubkey !== pubkey) return { ok: false, why: 'that account is linked to another report key' };
    const had = db.prepare('SELECT user_id FROM links WHERE pubkey = ? AND platform = ?').get(pubkey, platform);
    if (had && had.user_id === String(userId)) {
      db.prepare('UPDATE links SET username = ? WHERE pubkey = ? AND platform = ?').run(username ? String(username).slice(0, 64) : null, pubkey, platform);
      return { ok: true, pubkey, platform, again: true };
    }
    db.prepare(`INSERT INTO links (pubkey, platform, user_id, username, linked_ms, proof) VALUES (?, ?, ?, ?, ?, 'name')
      ON CONFLICT (pubkey, platform) DO UPDATE SET user_id = excluded.user_id, username = excluded.username, linked_ms = excluded.linked_ms, member = NULL, checked_ms = NULL, why = NULL, proof = 'name'`)
      .run(pubkey, platform, String(userId), username ? String(username).slice(0, 64) : null, nowMs);
    return { ok: true, pubkey, platform };
  }

  /**
   * THE TELEGRAM NAMES THE BOT HAS SEEN (kanban #2641): the Bot API cannot turn a @username into a user id, so the bot keeps username -> id from every
   * update it gets (group messages, joins, member changes, direct messages). Usernames are kept lower case, without the @.
   */
  const tgName = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();
  function seeTelegram({ userId, username, nowMs = Date.now() } = {}) {
    const n = tgName(username);
    if (!userId || !/^[a-z0-9_]{4,32}$/.test(n)) return false;
    db.prepare('INSERT INTO tg_seen (username, user_id, seen_ms) VALUES (?, ?, ?) ON CONFLICT (username) DO UPDATE SET user_id = excluded.user_id, seen_ms = excluded.seen_ms')
      .run(n, String(userId), nowMs);
    return true;
  }
  function telegramIdOf(username) { const x = db.prepare('SELECT user_id FROM tg_seen WHERE username = ?').get(tgName(username)); return x ? x.user_id : null; }

  const linkRow = (x) => ({ platform: x.platform, userId: x.user_id, username: x.username, proof: x.proof || 'code', linkedMs: x.linked_ms, member: x.member == null ? null : !!x.member, checkedMs: x.checked_ms, why: x.why });
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

  const botXHandles = () => { try { const f = process.env.FAUCET_BOT_X_HANDLES; return new Set(f ? readFileSync(f, 'utf8').split('\n').map((l) => l.trim().replace(/^@/, '').toLowerCase()).filter((l) => l && !l.startsWith('#')) : []); } catch { return new Set(); } };
  /**
   * A MEMBER READ IN A WINDOW (kanban #3278, #3281: the Orange Pill Run's "verified by 1 hour after the round"): whether a read of this key's link to
   * account `userId` said member at a time from fromMs to toMs. The link row keeps only its last read, which a later read moves; `checks` keeps them all.
   */
  function memberRead(pubkey, platform, { userId, fromMs = 0, toMs } = {}) {
    return !!db.prepare('SELECT 1 AS x FROM checks WHERE pubkey = ? AND platform = ? AND user_id = ? AND member = 1 AND at_ms >= ? AND at_ms <= ? LIMIT 1')
      .get(String(pubkey), String(platform), String(userId), Number(fromMs) || 0, Number(toMs));
  }

  /** THE STORED FLAGS of a key: a platform counts when its last read said member and is fresh (CHECK_FRESH_MS). */
  function flagsOf(pubkey, { nowMs = Date.now() } = {}) {
    const f = { telegram: false, discord: false, x: false, armada: false, nostr: false };
    const links = linksOf(pubkey);
    // A KNOWN AI BOT IS A BOT, WHATEVER IT LINKS (kanban #2958, the owner 2026-11-17 on x.com/damaidams: "Alle tickets mit diesem handle als bot
    // markieren, auch in Zukunft"): a key that links an X handle on the bot list (FAUCET_BOT_X_HANDLES file, read on every call) gets no flag -
    // not human, no social bonus - for every report, past and future
    const bots = botXHandles(), listed = (n) => bots.has(String(n || '').replace(/^@/, '').toLowerCase());
    if (links.some((l) => l.platform === 'x' && (listed(l.username) || (bots.size && namesOf.all('x', String(l.userId)).some((r) => listed(r.username)))))) return { ...f, bot: true };
    // A NAME FOUND LIVE COUNTS LIKE A POSTED CODE (kanban #3722, the owner 2026-11-25: "Link code muss nicht sein, entfern das"; before: #2645, #2657
    // counted only proof 'code'): an account typed in the form and found live as a member (proof 'name') counts once its last read said member and is
    // fresh - X makes the reporter human, each platform gives its bonus. The link code stays an optional way (proof 'code'); one key per account
    // (claimName); the bot list above and the owner's real-user mark below are unchanged. A Nostr key also counts when it is the report key itself
    const owned = (l) => l.proof === 'code' || l.proof === 'name' || (l.platform === 'nostr' && String(l.userId || '').toLowerCase() === String(pubkey).toLowerCase());
    for (const l of links) if (owned(l) && l.member === true && l.checkedMs != null && nowMs - l.checkedMs <= CHECK_FRESH_MS) f[l.platform] = true;
    // THE OWNER'S REAL-USER MARK MAKES A HUMAN (owner 2026-11-23: "Wenn der X hat, dann ist er ein echter User"): human share, no extra bonus
    try { if (realUserOf(pubkey)) f.realUser = true; } catch (_) {}
    return f;
  }

  /**
   * WHAT THE POT COUNTS, ONE ROW PER APPROVED REPORT (kanban #3327, feedback #386): { report, season, sats, paid } - paid: the reward's paid amount;
   * not paid yet (its claim link open, or no link made yet): what it pays now under the current rule. `season` null: every season.
   */
  function counted(season = null) {
    const out = [];
    for (const a of db.prepare(`SELECT * FROM approvals WHERE (? IS NULL OR season = ?) AND state = 'approved' ORDER BY at_ms`).all(season, season)) {
      const paid = typeof paidOf === 'function' ? paidOf(a.report) : null;
      if (Number.isInteger(paid) && paid >= 0) { out.push({ report: a.report, season: a.season, sats: paid, paid: true }); continue; }
      const now = seasonPayout({ level: a.level, codeOnly: !!a.code_only, followUp: !!a.follow_up, flags: a.level === 'node' ? {} : JSON.parse(a.flags || '{}') });
      out.push({ report: a.report, season: a.season, sats: now.ok ? Math.min(now.sats, a.sats) : a.sats, paid: false });
    }
    return out;
  }

  function pot(season) {
    const s = Number(season);
    // WHAT THE POT HAS REALLY GIVEN (kanban #2784, the owner 2026-11-15): an approval counts what was paid for it, else what it pays now under the
    // current rule (seasonPayout from its stored level, code-only, follow-up and flags; never above its stored amount). The stored amount alone
    // kept the old 50 % approvals at 50 % after they were paid at 25 %: 11,750 used where 5,875 was paid or payable.
    // kanban #3327 (feedback #386): what it counts, per approval, is counted() - the payout log lists the same rows, paid and not yet paid
    let used = 0, paidSats = 0;
    for (const c of counted(s)) { used += c.sats; if (c.paid) paidSats += c.sats; }
    const waiting = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(sats), 0) AS s FROM approvals WHERE state = 'waiting'`).get();
    const nodes = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE season = ? AND state = 'approved' AND level = 'node'`).get(s).n;
    const pot = potOf(s);
    return { season: s, potSats: pot, usedSats: used, paidSats, owedSats: used - paidSats, leftSats: pot - used, drawPrizeSats: drawPrizeOf(s), nodes, nodesMost: NODES_PER_SEASON, waiting: { n: waiting.n, sats: waiting.s } };
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
  function keep(report, p, state, { by = null, nowMs = Date.now() } = {}, prior = null) {
    db.prepare(`INSERT INTO approvals (report, pubkey, season, level, code_only, follow_up, base_sats, bonus_pct, sats, state, flags, at_ms, by, intent_prior)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (report) DO UPDATE SET season = excluded.season, level = excluded.level, code_only = excluded.code_only,
      follow_up = excluded.follow_up, base_sats = excluded.base_sats, bonus_pct = excluded.bonus_pct, sats = excluded.sats, state = excluded.state, flags = excluded.flags,
      at_ms = excluded.at_ms, by = excluded.by, intent_prior = excluded.intent_prior`)
      .run(report.id, report.pubkey, p.season, p.level, p.codeOnly ? 1 : 0, p.followUp ? 1 : 0, p.baseSats, p.bonusPct, p.sats, state, JSON.stringify(p.flags || {}), nowMs, by, prior);
    return approval(report.id);
  }
  const commit = (report, p, o) => keep(report, p, 'approved', o);
  const wait = (report, p, o) => keep(report, p, 'waiting', o);
  /**
   * A SEASON 2 APPROVAL IS WRITTEN HERE FIRST, AS AN INTENT (kanban #3220, state audit SM-21): the report's accepted state lives in feedback.db, the
   * approval in this file - two files, no shared transaction. intend() records the plan as 'approving' (the row it replaces kept) before the report
   * store approves; settle(id, true) makes it 'approved', settle(id, false) puts the earlier row back ('dropped' when there was none). A write that
   * fails between the two leaves an 'approving' row, which the faucet's reconcile pass settles by the report's state - nothing is lost either way.
   */
  function intend(report, p, o) {
    const had = db.prepare('SELECT * FROM approvals WHERE report = ?').get(report.id);
    const prior = !had ? null : had.state === 'approving' ? had.intent_prior : JSON.stringify(had);   // an intent again keeps the first one's row
    return keep(report, p, 'approving', o, prior);
  }
  function settle(id, approved) {
    const row = db.prepare("SELECT * FROM approvals WHERE report = ? AND state = 'approving'").get(String(id));
    if (!row) return approval(id);
    if (approved) db.prepare("UPDATE approvals SET state = 'approved', intent_prior = NULL WHERE report = ? AND state = 'approving'").run(row.report);
    else if (!row.intent_prior) db.prepare("UPDATE approvals SET state = 'dropped', intent_prior = NULL WHERE report = ? AND state = 'approving'").run(row.report);
    else { const x = JSON.parse(row.intent_prior);
      db.prepare(`UPDATE approvals SET season = ?, level = ?, code_only = ?, follow_up = ?, base_sats = ?, bonus_pct = ?, sats = ?, state = ?, flags = ?, at_ms = ?,
        payable_sats = ?, payable_ms = ?, payable_why = ?, by = ?, intent_prior = NULL WHERE report = ? AND state = 'approving'`)
        .run(x.season, x.level, x.code_only, x.follow_up, x.base_sats, x.bonus_pct, x.sats, x.state, x.flags, x.at_ms, x.payable_sats ?? null, x.payable_ms ?? null, x.payable_why ?? null, x.by ?? null, row.report); }
    return approval(id);
  }

  const approvalRow = (x) => (x ? { report: x.report, pubkey: x.pubkey, season: x.season, level: x.level, codeOnly: !!x.code_only, followUp: !!x.follow_up,
    baseSats: x.base_sats, bonusPct: x.bonus_pct, sats: x.sats, state: x.state, flags: JSON.parse(x.flags || '{}'), atMs: x.at_ms,
    payableSats: x.payable_sats, payableMs: x.payable_ms, payableWhy: x.payable_why || null } : null);
  const approval = (id) => approvalRow(db.prepare('SELECT * FROM approvals WHERE report = ?').get(String(id)));
  const approvals = ({ season = null, state = null } = {}) => db.prepare(`SELECT * FROM approvals WHERE (? IS NULL OR season = ?) AND (? IS NULL OR state = ?) ORDER BY at_ms`)
    .all(season, season, state, state).map(approvalRow);

  /**
   * BEFORE PAYOUT: the bonus read again from flags just verified. The payable amount never rises above the approved one (a bonus lost since is taken
   * off; one gained since waits for the next report). Stored on the approval with its time; nothing is paid here.
   */
  /** A REPORT REJECTED OR MARKED DUPLICATE TAKES ITS APPROVAL BACK (kanban #2904): approved, waiting or approving (kanban #3220) -> rejected, nothing payable; answers whether one moved. */
  function voidApproval(id, { why = 'the report was rejected', nowMs = Date.now() } = {}) {
    return db.prepare("UPDATE approvals SET state = 'rejected', payable_sats = 0, payable_ms = ?, payable_why = ?, intent_prior = NULL WHERE report = ? AND state IN ('approved', 'waiting', 'approving')")
      .run(nowMs, String(why).slice(0, 200), String(id)).changes === 1;
  }
  function payable(id, { nowMs = Date.now() } = {}) {
    const a = approval(id);
    if (!a || a.state !== 'approved') return { ok: false, why: 'no Season 2 approval for that report' };
    const p = seasonPayout({ level: a.level, codeOnly: a.codeOnly, followUp: a.followUp, flags: a.level === 'node' ? {} : flagsOf(a.pubkey, { nowMs }) });
    const sats = Math.min(p.sats, a.sats);
    // WHY IT WENT DOWN (the owner 2026-11-14, kanban #2641: "tun ggf nochmal den Betrag reduzieren wenn der User nicht mehr in den angegeben socials ist"):
    // the communities counted at approval that do not count now (left, or not readable now - a failed read is no member)
    const now = a.level === 'node' ? {} : flagsOf(a.pubkey, { nowMs });
    const NAMES = { x: 'X', telegram: 'Telegram', discord: 'Discord', armada: 'Armada' };
    const lost = PLATFORMS.filter((k) => a.flags && a.flags[k] === true && now[k] !== true);
    // nothing left and no bonus lost: the rule itself went down (kanban #2784: the bot share 25 % -> 15 %)
    const why = sats < a.sats ? (!lost.length && a.bonusPct === p.bonusPct ? `the bot share is ${BOT_PCT} % now (approved ${a.sats})` : `left ${lost.map((k) => NAMES[k]).join(', ') || 'a community'}: -${a.bonusPct - p.bonusPct} %${!a.codeOnly && p.quarter ? `, no linked X account: ${BOT_PCT} %` : ''}`) : null;   // kanban #2788: X proves a human
    db.prepare('UPDATE approvals SET payable_sats = ?, payable_ms = ?, payable_why = ? WHERE report = ?').run(sats, nowMs, why, a.report);
    return { ok: true, report: a.report, approvedSats: a.sats, payableSats: sats, bonusPct: Math.min(p.bonusPct, a.bonusPct), flags: now, lost, why };
  }

  /**
   * THE DRAW'S ENTRIES for a season: every key with an approved report in it that is a member of Telegram, Discord or Armada (fresh read) - one entry
   * per person, i.e. per report key, however many of the three it is in (the owner 2026-11-14, kanban #2641: "Ein user darf entweder in discord, Armada
   * oder telegram gezählt [werden], er wird aber nur einmal gezählt"); an account belongs to one key only (links_by_account). Named by its platform
   * username (telegram, then discord, then armada). Call after verify() for each key (membership is read again right before the draw).
   */
  function drawEntries(season, { nowMs = Date.now() } = {}) {
    const keys = db.prepare(`SELECT DISTINCT pubkey FROM approvals WHERE season = ? AND state = 'approved' AND level <> 'node'`).all(Number(season)).map((x) => x.pubkey);
    const picks = [];
    for (const k of keys) {
      const f = flagsOf(k, { nowMs });
      const ls = linksOf(k);
      const pick = COMMUNITIES.map((p) => f[p] && ls.find((l) => l.platform === p)).find(Boolean) || null;
      // THE NAME THE ACCOUNT FIRST CARRIED (kanban #3056, audit faucet r4-2-1): the entries are read after the seed block is public, and an entrant
      // renamed his linked account (same id, claimName/redeem update the name) until the published draw gave him place 1. An entry names the
      // account by the first name this store saw for it (link_names, in the order kept), which no later rename moves
      // (kept lower-case there: the current name is shown while it is that first name in any case)
      if (pick) {
        const first = pick.userId ? firstNameOf.get(pick.platform, String(pick.userId)) : null;
        const shown = first && first.username && String(pick.username || '').toLowerCase() !== first.username ? first.username : (pick.username || pick.userId);
        picks.push({ name: `${pick.platform}:${shown}`, id: `${pick.platform}:${pick.userId || k}`, key: k });
      }
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

  return { makeCode, redeem, claimName, seeTelegram, telegramIdOf, links: linksOf, record, memberRead, verify, flagsOf, pot, counted, plan, commit, wait, intend, settle, approval, approvals, payable, voidApproval, drawEntries, keysOfSeason,
    seasonNow, realUserOf, markRealUser, clearRealUser, playedMarkOf, markPlayed, clearPlayed, close: () => db.close() };
}
