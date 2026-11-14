// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SOCIAL SCREEN'S LIVE CHECK (Week 2, kanban #2641, Daniel 2026-11-14: "der User gibt jeweils seine usernames dafür an und prüft live ob er da
// wirklich in der community ist"): the reporter types a name per platform (all optional) - X, Telegram, Discord, Armada - and each is read live.
// A name found as a member is linked to the signed-in report key (one key per account); the answer says per platform member yes/no and the bonus
// that follows (X +25 %, 2 of Telegram / Discord / Armada +25 %).
import { readFileSync } from 'node:fs';
import { PLATFORMS, bonusPct } from './bounty-season.js';
import { discordSearch, telegramByName, telegramVerifier, xByName, xSessionFromChrome } from './bounty-verify.js';

const linksOut = (S2, pubkey) => S2.links(pubkey).map(({ userId, ...l }) => l);

/**
 * CHECK THE NAMES `asked` ({ x, telegram, discord, armada }: strings, empty = not asked) for `pubkey` with `resolvers[platform](name) ->
 * { userId, username, member, why, unseen? }`. A member is linked (S2.claimName) and its read stored with its time; a name that is no member, or
 * that could not be read, links nothing. Answers { ok, results: { platform: { member, why, username?, unseen? } }, flags, bonusPct, links }.
 */
export async function socialCheck(S2, pubkey, asked, resolvers, { nowMs = () => Date.now() } = {}) {
  const results = {};
  for (const p of PLATFORMS) {
    const raw = asked && typeof asked[p] === 'string' ? asked[p].trim().slice(0, 120) : '';
    if (!raw) continue;
    const f = resolvers[p];
    if (!f) { results[p] = { member: null, why: 'this check is not on yet' }; continue; }
    let r;
    try { r = (await f(raw)) || {}; } catch { r = { member: null, why: 'could not be read: try again' }; }
    const out = { member: r.member === true ? true : r.member === false ? false : null, why: r.why ? String(r.why).slice(0, 200) : null };
    if (r.username) out.username = String(r.username).slice(0, 64);
    if (r.unseen) out.unseen = true;
    if (out.member === true && r.userId) {
      const c = S2.claimName(pubkey, p, { userId: String(r.userId), username: out.username || raw, nowMs: nowMs() });
      if (!c.ok) { results[p] = { member: null, why: c.why, username: out.username }; continue; }
      S2.record(pubkey, p, { member: true, why: out.why, cause: 'form', nowMs: nowMs() });
    } else if (out.member === true) out.member = null;
    results[p] = out;
  }
  const flags = S2.flagsOf(pubkey, { nowMs: nowMs() });
  return { ok: true, results, flags, bonusPct: bonusPct(flags), links: linksOut(S2, pubkey) };
}

/**
 * THE RESOLVERS FROM THE CONFIG (the same secret files the verifiers read): X from the X browser's session, Discord from the bot token, Telegram from
 * the user account reader (if logged in) or the bot's seen-map plus getChatMember, Armada from the module of that name. A platform without its
 * config has no resolver (its answer says the check is not on).
 */
export function resolversFromEnv(S2, env = process.env, { userbot = null, armada = null } = {}) {
  const rd = (f) => { try { return f ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
  const out = {};
  if (env.FAUCET_BOUNTY_X_PORT) out.x = xByName({ session: () => xSessionFromChrome({ port: Number(env.FAUCET_BOUNTY_X_PORT) }) });
  const dc = rd(env.FAUCET_BOUNTY_DISCORD_TOKEN_FILE), guild = rd(env.FAUCET_BOUNTY_DISCORD_GUILD_FILE);
  if (dc && guild) out.discord = discordSearch({ token: dc, guildId: guild });
  const tg = rd(env.FAUCET_BOUNTY_TG_TOKEN_FILE), chat = rd(env.FAUCET_BOUNTY_TG_CHAT_FILE);
  if ((tg && chat) || userbot) {
    const verify = tg && chat ? telegramVerifier({ token: tg, chatId: chat }) : async () => ({ member: null, why: 'no bot' });
    out.telegram = telegramByName({ idOf: (n) => S2.telegramIdOf(n), verify, userbot });
  }
  if (armada) out.armada = armada;
  return out;
}
