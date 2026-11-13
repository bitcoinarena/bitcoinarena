#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON 2 LINK BOTS (kanban #2623): a reporter gets a one-time code (BA-XXXXXXXX) in My feedback and posts it - `/link <code>` to the Telegram bot
// or in the group, `/link code:<code>` (or a DM) to the Discord bot, or an X post naming @bitcoinarena_io with the code. The account is linked to the
// report key in the Season 2 file (FAUCET_BOUNTY_S2_DB, the faucet's own) and its membership read at once and stored with the time.
// X is read only: one search every BOUNTY_X_EVERY_MS, never a post, like, follow or message. Secrets are read from their files and never printed.
//   FAUCET_BOUNTY_S2_DB=... FAUCET_BOUNTY_TG_TOKEN_FILE=... FAUCET_BOUNTY_TG_CHAT_FILE=... FAUCET_BOUNTY_DISCORD_TOKEN_FILE=... FAUCET_BOUNTY_DISCORD_GUILD_FILE=...
//   FAUCET_BOUNTY_X_PORT=9402 node tools/bounty-link-bot.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBountySeason, LINK_CODE_RE } from '../src/bounty-season.js';
import { verifiersFromEnv, xSearch, xSessionFromChrome, X_ACCOUNT } from '../src/bounty-verify.js';

const NAMES = { telegram: 'Telegram', discord: 'Discord', x: 'X' };
/** ONE POSTED CODE: link it, read the membership at once, and the words the bot answers with. */
export async function linkFromText(S2, verifiers, { platform, userId, username, text, nowMs = Date.now() }) {
  if (!LINK_CODE_RE.test(String(text || ''))) return null;
  const r = S2.redeem(text, { platform, userId, username, nowMs });
  if (!r.ok) return { ok: false, reply: `Not linked: ${r.why}.` };
  const flags = await S2.verify(r.pubkey, { [platform]: verifiers[platform] }, { cause: 'link' });
  const said = platform === 'x' ? (flags.x ? 'you follow @bitcoinarena_io: +25% on confirmed reports' : 'you do not follow @bitcoinarena_io yet - follow, then press Check again in My feedback')
    : flags[platform] ? 'you are a member: +50% on confirmed reports, and you are in the draw of the week with a confirmed report' : 'you are not a member yet - join, then press Check again in My feedback';
  return { ok: true, pubkey: r.pubkey, reply: `${NAMES[platform]} linked to your report key; ${said}.` };
}

const rd = (f) => { try { return f ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function telegramLoop(S2, verifiers, token) {
  const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) }).then((r) => r.json());
  let offset = 0;
  for (;;) {
    try {
      const u = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const x of (u && u.result) || []) {
        offset = x.update_id + 1;
        const m = x.message; if (!m || !m.from || m.from.is_bot || typeof m.text !== 'string' || !/^\/link(@\w+)?\b/i.test(m.text.trim())) continue;
        const out = await linkFromText(S2, verifiers, { platform: 'telegram', userId: String(m.from.id), username: m.from.username ? `@${m.from.username}` : (m.from.first_name || String(m.from.id)), text: m.text });
        const reply = out ? out.reply : 'Send /link followed by the code from My feedback, like /link BA-ABCD2345.';
        await api('sendMessage', { chat_id: m.chat.id, text: reply, reply_to_message_id: m.message_id }).catch(() => null);
        log('telegram', out ? (out.ok ? 'linked' : 'refused') : 'no code');
      }
    } catch (e) { log('telegram', String((e && e.message) || e).replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 100)); await new Promise((r) => setTimeout(r, 5000)); }
  }
}

async function discordLoop(S2, verifiers, token, guildId) {
  const H = { authorization: `Bot ${token}`, 'content-type': 'application/json' };
  const rest = (path, method = 'GET', body) => fetch(`https://discord.com/api/v10${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const app = await (await rest('/applications/@me')).json();
  // the one slash command, created or updated by name (never a bulk overwrite: other commands of the bot stay)
  const made = await rest(`/applications/${app.id}/guilds/${guildId}/commands`, 'POST', { name: 'link', type: 1, description: 'Link Discord to your Bitcoin Arena report key (code from My feedback)',
    options: [{ type: 3, name: 'code', description: 'The code, like BA-ABCD2345', required: true }] });
  log('discord command', made.status);
  const connect = () => new Promise((done) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); let seq = null, beat = null;
    ws.onmessage = async (msg) => {
      const p = JSON.parse(msg.data); if (p.s != null) seq = p.s;
      if (p.op === 10) { beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), p.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token, intents: (1 << 12), properties: { os: 'linux', browser: 'arena', device: 'arena' } } })); return; }
      if (p.op === 1) { ws.send(JSON.stringify({ op: 1, d: seq })); return; }
      if (p.op === 7 || p.op === 9) { ws.close(); return; }
      if (p.op !== 0) return;
      try {
        if (p.t === 'INTERACTION_CREATE' && p.d.type === 2 && p.d.data && p.d.data.name === 'link') {
          const user = (p.d.member && p.d.member.user) || p.d.user; const code = ((p.d.data.options || [])[0] || {}).value || '';
          const out = await linkFromText(S2, verifiers, { platform: 'discord', userId: user.id, username: user.username, text: code });
          await rest(`/interactions/${p.d.id}/${p.d.token}/callback`, 'POST', { type: 4, data: { flags: 64, content: out ? out.reply : 'That is not a code from My feedback (like BA-ABCD2345).' } });
          log('discord', out ? (out.ok ? 'linked' : 'refused') : 'no code');
        } else if (p.t === 'MESSAGE_CREATE' && !p.d.guild_id && p.d.author && !p.d.author.bot) {
          const out = await linkFromText(S2, verifiers, { platform: 'discord', userId: p.d.author.id, username: p.d.author.username, text: p.d.content });
          if (out) { await rest(`/channels/${p.d.channel_id}/messages`, 'POST', { content: out.reply }); log('discord dm', out.ok ? 'linked' : 'refused'); }
        }
      } catch (e) { log('discord', String((e && e.message) || e).slice(0, 100)); }
    };
    ws.onclose = () => { clearInterval(beat); done(); };
    ws.onerror = () => {};
  });
  for (;;) { await connect(); log('discord gateway closed, again in 5 s'); await new Promise((r) => setTimeout(r, 5000)); }
}

async function xLoop(S2, verifiers, port, everyMs) {
  const seen = new Set();
  for (;;) {
    try {
      const posts = await xSearch(`@${X_ACCOUNT} BA-`, { session: () => xSessionFromChrome({ port }) });
      for (const p of posts) {
        if (seen.has(p.id)) continue; seen.add(p.id);
        const out = await linkFromText(S2, verifiers, { platform: 'x', userId: p.userId, username: p.name, text: p.text });
        if (out) log('x', out.ok ? 'linked' : 'refused');
      }
      if (seen.size > 20000) seen.clear();
    } catch (e) { log('x', String((e && e.message) || e).slice(0, 100)); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  if (!env.FAUCET_BOUNTY_S2_DB) { console.error('FAUCET_BOUNTY_S2_DB names the Season 2 file'); process.exit(2); }
  const S2 = openBountySeason(env.FAUCET_BOUNTY_S2_DB, { startMs: env.FAUCET_BOUNTY_S2_START ? Date.parse(env.FAUCET_BOUNTY_S2_START) : null });
  const verifiers = verifiersFromEnv(env);
  const tg = rd(env.FAUCET_BOUNTY_TG_TOKEN_FILE), dc = rd(env.FAUCET_BOUNTY_DISCORD_TOKEN_FILE), guild = rd(env.FAUCET_BOUNTY_DISCORD_GUILD_FILE);
  log('link bots:', [tg && 'telegram', dc && guild && 'discord', env.FAUCET_BOUNTY_X_PORT && 'x'].filter(Boolean).join(', '));
  if (tg) telegramLoop(S2, verifiers, tg);
  if (dc && guild) discordLoop(S2, verifiers, dc, guild).catch((e) => log('discord stopped', String(e.message).slice(0, 100)));
  if (env.FAUCET_BOUNTY_X_PORT) xLoop(S2, verifiers, Number(env.FAUCET_BOUNTY_X_PORT), Number(env.BOUNTY_X_EVERY_MS || 180000));
}
