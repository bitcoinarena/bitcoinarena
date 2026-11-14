// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TELEGRAM MEMBER LIST, READ BY A USER ACCOUNT (kanban #2641, Daniel 2026-11-14: "einen eigenen bot wo wir die live user Liste auslesen koennen"):
// the Bot API cannot turn a @username into a member, so a Telegram user account of ours that sits in the group reads the group's participants over
// MTProto (the gramjs `telegram` package) and a @username is looked up in that list. READ ONLY: the client is wrapped so that only the read calls
// below reach it - it never sends, joins, leaves or changes anything. Credentials are config only (files under ~/.config/blwp, 0600): the api id, the
// api hash and a StringSession made once by tools/telegram-userbot-login.mjs. Any of them missing: the reader is off and the bot's own path runs.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** THE ONLY CALLS THE READER MAKES on the MTProto client: connect, find the group (getEntity, else the dialogs), read its participants, disconnect. */
export const READ_CALLS = Object.freeze(['connect', 'getEntity', 'getDialogs', 'getParticipants', 'disconnect']);

/** The client as the reader sees it: the read calls only; any other method throws before it reaches Telegram. */
export function readOnly(client) {
  return new Proxy({}, { get(_, k) {
    if (READ_CALLS.includes(k)) return (...a) => client[k](...a);
    throw new Error(`the Telegram reader is read-only: ${String(k)} is not allowed`);
  } });
}

const short = (e) => String((e && e.message) || e).slice(0, 120);
const lower = (u) => String(u || '').replace(/^@/, '').toLowerCase();
/** Every username of a participant: its main one and its active collectible ones. */
export function namesOf(u) {
  const out = [];
  if (u && u.username) out.push(lower(u.username));
  for (const x of (u && Array.isArray(u.usernames) ? u.usernames : [])) if (x && x.username && x.active !== false) out.push(lower(x.username));
  return [...new Set(out)];
}
/** The group's dialog for a Bot API chat id (-123 a group, -100123 a supergroup): gramjs marks dialog ids the same way. */
const sameChat = (dialog, chatId) => String(dialog && dialog.id) === String(chatId);

/**
 * THE READER: `client` a connected-or-not gramjs TelegramClient (or a fake with the same read calls), `chatId` the group's Bot API id. The member
 * list is read once per `cacheMs` and serves every check in between. Answers (username) -> { member: true | false | null, userId, why }.
 */
export function telegramUserbot({ client, chatId, cacheMs = 60000, nowMs = () => Date.now() }) {
  const c = readOnly(client);
  let list = null, at = 0, entity = null, connected = false, reading = null;
  async function members() {
    if (list && nowMs() - at < cacheMs) return list;
    if (reading) return reading;
    reading = (async () => {
      if (!connected) { await c.connect(); connected = true; }
      if (!entity) { try { entity = await c.getEntity(Number(chatId)); } catch { entity = null; } }
      if (!entity) {
        const ds = await c.getDialogs({ limit: 200 });
        const d = (ds || []).find((x) => sameChat(x, chatId));
        if (!d) throw new Error('the reader account is not in the group');
        entity = d.entity || d.inputEntity || d;
      }
      const ps = await c.getParticipants(entity, { limit: 10000 });
      const m = new Map();
      for (const u of ps || []) { if (!u || u.deleted) continue; for (const n of namesOf(u)) m.set(n, String(u.id)); }
      list = m; at = nowMs();
      return m;
    })().finally(() => { reading = null; });
    return reading;
  }
  return async (username) => {
    const n = lower(username);
    if (!/^[a-z][a-z0-9_]{3,31}$/.test(n)) return { member: null, why: 'no Telegram username' };
    try {
      const m = await members();
      return m.has(n) ? { member: true, userId: m.get(n), why: 'in the group (member list)' } : { member: false, why: 'not in the group (member list)' };
    } catch (e) { return { member: null, why: short(e) }; }
  };
}

const rd = (f) => { try { return f ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
/** The credential files: FAUCET_BOUNTY_TG_USERBOT_{API_ID,API_HASH,SESSION}_FILE, by default under ~/.config/blwp. */
export function userbotFiles(env = process.env) {
  const dir = join(homedir(), '.config', 'blwp');
  return { apiId: env.FAUCET_BOUNTY_TG_USERBOT_API_ID_FILE || join(dir, 'telegram-userbot-api-id'),
    apiHash: env.FAUCET_BOUNTY_TG_USERBOT_API_HASH_FILE || join(dir, 'telegram-userbot-api-hash'),
    session: env.FAUCET_BOUNTY_TG_USERBOT_SESSION_FILE || join(dir, 'telegram-userbot.session') };
}

/**
 * THE READER FROM THE CONFIG, or null (off): the three files and the group's chat id (FAUCET_BOUNTY_TG_CHAT_FILE) present, and the `telegram`
 * package installed. `load` is the package import (tests pass a fake).
 */
export async function userbotFromEnv(env = process.env, { load = () => import('telegram'), log = () => {} } = {}) {
  if (env.FAUCET_BOUNTY_TG_USERBOT === 'off') return null;
  const f = userbotFiles(env);
  const apiId = Number(rd(f.apiId)), apiHash = rd(f.apiHash), session = rd(f.session), chatId = rd(env.FAUCET_BOUNTY_TG_CHAT_FILE);
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !session || !chatId) { log('telegram reader off: no credentials'); return null; }
  let lib;
  try { lib = await load(); } catch { log('telegram reader off: the telegram package is not installed'); return null; }
  const { TelegramClient } = lib; const { StringSession } = lib.sessions || {};
  if (!TelegramClient || !StringSession) { log('telegram reader off: the telegram package has no client'); return null; }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3, baseLogger: undefined });
  if (client.setLogLevel) client.setLogLevel('none');
  log('telegram reader on');
  return telegramUserbot({ client, chatId });
}
