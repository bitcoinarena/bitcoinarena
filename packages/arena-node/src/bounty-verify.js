// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIVE MEMBERSHIP READS FOR THE SEASON 2 BONUS (kanban #2623): Telegram getChatMember, Discord GET /guilds/{id}/members/{user}, and whether an X
// account follows @bitcoinarena_io (X's own web API with the session of the logged-in X browser, read-only). Each answers { member: true | false | null,
// why }. Secrets come in as arguments and are never put into an answer, a log line or an error text.
import { readFileSync } from 'node:fs';

const TG_MEMBER = new Set(['creator', 'administrator', 'member']);
const short = (e) => String((e && e.message) || e).replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 120);

export function telegramVerifier({ token, chatId, fetchFn = fetch, timeoutMs = 8000 }) {
  return async (link) => {
    try {
      const r = await fetchFn(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(link.userId)}`, { signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return { member: j && j.error_code === 400 ? false : null, why: j && j.description ? String(j.description).slice(0, 80) : `telegram ${r.status}` };
      const st = j.result && j.result.status;
      return { member: TG_MEMBER.has(st) || (st === 'restricted' && j.result.is_member === true), why: st || null };
    } catch (e) { return { member: null, why: short(e) }; }
  };
}

export function discordVerifier({ token, guildId, fetchFn = fetch, timeoutMs = 8000 }) {
  return async (link) => {
    try {
      const r = await fetchFn(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(link.userId)}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 200) { const j = await r.json().catch(() => ({})); return { member: !j.pending, why: j.pending ? 'membership screening pending' : 'member' }; }
      if (r.status === 404) return { member: false, why: 'not in the server' };
      return { member: null, why: `discord ${r.status}` };
    } catch (e) { return { member: null, why: short(e) }; }
  };
}

/** A DISCORD NAME AS TYPED: the username (lower case, no @, no "#0"); null when it cannot be one (2-32 of a-z 0-9 _ .). */
export function discordName(input) {
  const n = String(input || '').trim().replace(/^@/, '').replace(/#0$/, '').toLowerCase();
  return /^[a-z0-9_.]{2,32}$/.test(n) ? n : null;
}

/**
 * A DISCORD USERNAME -> MEMBER OF OUR SERVER (Week 2, kanban #2641): GET /guilds/{id}/members/search?query=<name> with the bot's token, then the one
 * member whose username is exactly that name (the search matches prefixes of usernames and nicknames). Answers { userId, username, member, why }:
 * userId null when no member has that username (not in the server); member false while membership screening is pending.
 */
export function discordSearch({ token, guildId, fetchFn = fetch, timeoutMs = 8000 }) {
  return async (input) => {
    const name = discordName(input);
    if (!name) return { userId: null, member: null, why: 'that is not a Discord username' };
    try {
      const r = await fetchFn(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/search?query=${encodeURIComponent(name)}&limit=100`,
        { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status !== 200) return { userId: null, member: null, why: `discord ${r.status}` };
      const list = await r.json().catch(() => null);
      if (!Array.isArray(list)) return { userId: null, member: null, why: 'discord answered no list' };
      const m = list.find((x) => x && x.user && String(x.user.username || '').toLowerCase() === name && !x.user.bot);
      if (!m) return { userId: null, username: name, member: false, why: 'not in the server' };
      return { userId: String(m.user.id), username: m.user.username, member: !m.pending, why: m.pending ? 'membership screening pending' : 'member' };
    } catch (e) { return { userId: null, member: null, why: short(e) }; }
  };
}

/** A TELEGRAM NAME AS TYPED: the username without @ (5-32 of a-z 0-9 _, lower case); null when it cannot be one. */
export function telegramName(input) {
  const n = String(input || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').toLowerCase();
  return /^[a-z][a-z0-9_]{3,31}$/.test(n) ? n : null;
}

/**
 * A TELEGRAM USERNAME -> MEMBER OF OUR GROUP (kanban #2641). With the user account reader (`userbot`, src/telegram-userbot.js) the group's live member
 * list answers it directly. Without it the name must be one the bot has seen (`idOf`, the seen-map the link bot keeps) and getChatMember reads it live;
 * a name it has not seen answers { userId: null, member: null, unseen: true }.
 */
export function telegramByName({ idOf, verify, userbot = null }) {
  return async (input) => {
    const name = telegramName(input);
    if (!name) return { userId: null, member: null, why: 'that is not a Telegram username' };
    if (userbot) {
      const u = await userbot(name).catch((e) => ({ member: null, why: short(e) }));
      if (u && u.member !== null && u.member !== undefined) return { userId: u.userId || (idOf && idOf(name)) || null, username: `@${name}`, member: u.member, why: u.why || null };
    }
    const id = idOf ? idOf(name) : null;
    if (!id) return { userId: null, username: `@${name}`, member: null, unseen: true, why: 'not seen yet: write one message in the Bitcoin Arena Telegram group (or send your BA- code to @BitcoinArenaBot), then check again' };
    const r = await verify({ userId: id, username: `@${name}` });
    return { userId: id, username: `@${name}`, member: r.member, why: r.why };
  };
}

// THE X WEB APP'S PUBLIC BEARER: the constant the web client ships (not a secret, not tied to our account); X_WEB_BEARER overrides it
const X_WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
export const X_ACCOUNT = 'bitcoinarena_io';

/** THE X SESSION, read over the X browser's local debug port each time (cookies kept in memory only, never written anywhere). */
export async function xSessionFromChrome({ port = 9402, fetchFn = fetch } = {}) {
  const v = await (await fetchFn(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  try {
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('the X browser is not reachable')); });
    const got = await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('the X browser did not answer')), 5000);
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); ok(d); } };
      ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })); });
    const c = ((got.result && got.result.cookies) || []).filter((x) => /(^|\.)x\.com$/.test(x.domain));
    const ct0 = (c.find((x) => x.name === 'ct0') || {}).value;
    if (!ct0 || !c.some((x) => x.name === 'auth_token')) throw new Error('no logged-in X session');
    return { ct0, cookie: c.map((x) => `${x.name}=${x.value}`).join('; ') };
  } finally { try { ws.close(); } catch { /* closed */ } }
}
const xHeaders = (s) => ({ authorization: `Bearer ${decodeURIComponent(process.env.X_WEB_BEARER || X_WEB_BEARER)}`, 'x-csrf-token': s.ct0, cookie: s.cookie,
  'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session', 'content-type': 'application/json', 'user-agent': X_UA });

/** AT MOST ONE X CALL PER `gapMs` (X's limits are per 15 minutes; a burst would lock the account's reads). */
export function spaced(gapMs) { let next = 0; return async () => { const now = Date.now(); const at = Math.max(now, next); next = at + gapMs; if (at > now) await new Promise((r) => setTimeout(r, at - now)); }; }

export function xVerifier({ session = () => xSessionFromChrome(), fetchFn = fetch, gap = spaced(3000), timeoutMs = 10000 } = {}) {
  return async (link) => {
    const name = String(link.username || '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return { member: null, why: 'no X name' };
    try {
      const s = await session(); await gap();
      const r = await fetchFn(`https://x.com/i/api/1.1/friendships/show.json?source_screen_name=${X_ACCOUNT}&target_screen_name=${encodeURIComponent(name)}`, { headers: xHeaders(s), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null); const rel = j && j.relationship;
      if (r.status !== 200 || !rel) return { member: null, why: `x ${r.status}` };
      // the account's id must be the linked one: a name can be given away and taken by someone else
      if (link.userId && rel.target && rel.target.id_str && String(rel.target.id_str) !== String(link.userId)) return { member: false, why: 'that X name belongs to another account now' };
      return { member: !!(rel.target && rel.target.following), why: rel.target && rel.target.following ? 'follows' : 'does not follow' };
    } catch (e) { return { member: null, why: short(e) }; }
  };
}

/** AN X NAME -> FOLLOWS @bitcoinarena_io (kanban #2641): the same friendships/show read, answering the account's stable id with it. */
export function xByName({ session = () => xSessionFromChrome(), fetchFn = fetch, gap = spaced(3000), timeoutMs = 10000 } = {}) {
  return async (input) => {
    const name = String(input || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?].*$/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return { userId: null, member: null, why: 'that is not an X username' };
    try {
      const s = await session(); await gap();
      const r = await fetchFn(`https://x.com/i/api/1.1/friendships/show.json?source_screen_name=${X_ACCOUNT}&target_screen_name=${encodeURIComponent(name)}`, { headers: xHeaders(s), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null); const rel = j && j.relationship;
      if (r.status === 404 || (j && Array.isArray(j.errors) && j.errors.some((e) => e && (e.code === 50 || e.code === 163)))) return { userId: null, username: name, member: false, why: 'no such X account' };
      if (r.status !== 200 || !rel || !rel.target) return { userId: null, member: null, why: `x ${r.status}` };
      return { userId: rel.target.id_str ? String(rel.target.id_str) : null, username: rel.target.screen_name || name, member: !!rel.target.following, why: rel.target.following ? 'follows' : 'does not follow' };
    } catch (e) { return { userId: null, member: null, why: short(e) }; }
  };
}

/** THE NEWEST X POSTS FOR A QUERY (SearchTimeline, Latest): [{ id, text, userId, name }] - the posts a link code is looked for in. */
export async function xSearch(query, { session = () => xSessionFromChrome(), fetchFn = fetch, count = 40, queryId = 'vLHjqbDv7TPFMBkIIO1nOA' } = {}) {
  const s = await session();
  const r = await fetchFn(`https://x.com/i/api/graphql/${queryId}/SearchTimeline`, { method: 'POST', headers: xHeaders(s), signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ variables: { rawQuery: query, count, querySource: 'typed_query', product: 'Latest' }, features: {}, queryId }) });
  if (r.status !== 200) throw new Error(`x search ${r.status}`);
  return postsOf(await r.json());
}
/** Every post in a SearchTimeline answer, with its author's stable id and name. */
export function postsOf(body) {
  const out = [], seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (o.legacy && typeof o.legacy.full_text === 'string' && o.rest_id && o.core && o.core.user_results) {
      const u = o.core.user_results.result || {};
      const name = (u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name) || null;
      if (!seen.has(o.rest_id) && u.rest_id && name) { seen.add(o.rest_id); out.push({ id: String(o.rest_id), text: o.legacy.full_text, userId: String(u.rest_id), name: String(name) }); }
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, depth + 1);
  };
  walk(body, 0);
  return out;
}

/** The verifiers the faucet runs, from the secret files (FAUCET_BOUNTY_TG_TOKEN_FILE ...); a platform whose files are missing has none. */
export function verifiersFromEnv(env = process.env) {
  const rd = (f) => { try { return f ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
  const v = {};
  const tg = rd(env.FAUCET_BOUNTY_TG_TOKEN_FILE), tgChat = rd(env.FAUCET_BOUNTY_TG_CHAT_FILE);
  if (tg && tgChat) v.telegram = telegramVerifier({ token: tg, chatId: tgChat });
  const dc = rd(env.FAUCET_BOUNTY_DISCORD_TOKEN_FILE), dcGuild = rd(env.FAUCET_BOUNTY_DISCORD_GUILD_FILE);
  if (dc && dcGuild) v.discord = discordVerifier({ token: dc, guildId: dcGuild });
  if (env.FAUCET_BOUNTY_X_PORT) v.x = xVerifier({ session: () => xSessionFromChrome({ port: Number(env.FAUCET_BOUNTY_X_PORT) }) });
  return v;
}
