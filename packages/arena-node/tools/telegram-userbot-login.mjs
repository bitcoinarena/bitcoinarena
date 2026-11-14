#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ONE-TIME LOGIN OF THE TELEGRAM READER ACCOUNT (kanban #2641). It needs the api id and api hash of the account's Telegram app (my.telegram.org ->
// API development tools) in ~/.config/blwp/telegram-userbot-api-id and -api-hash (0600), and writes the session as a StringSession to
// ~/.config/blwp/telegram-userbot.session (0600). An old session file is moved aside, never deleted. No secret is printed. The account must already be
// a member of the group. Two ways:
//   in two steps (no terminal needed):
//     node tools/telegram-userbot-login.mjs --phone +49...          -> Telegram sends the login code; the half-done login is kept in a 0600 file
//     node tools/telegram-userbot-login.mjs --code 12345 [--password <2FA>]   -> signs in with that code and writes the session
//   or interactively: node tools/telegram-userbot-login.mjs        (asks for phone, code and 2FA password)
// Then restart arena-faucet (and arena-bounty-bots) to use it.
import { writeFileSync, existsSync, renameSync, readFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv } from 'node:process';
import { userbotFiles } from '../src/telegram-userbot.js';

const arg = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
const f = userbotFiles();
const PENDING = `${f.session}.pending.json`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const rd = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const put = (p, text) => { if (existsSync(p)) renameSync(p, `${p}.pre-${stamp()}`); writeFileSync(p, text, { mode: 0o600 }); chmodSync(p, 0o600); };
const apiId = Number(rd(f.apiId)), apiHash = rd(f.apiHash);
if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) { console.error(`put the api id in ${f.apiId} and the api hash in ${f.apiHash} first (chmod 600)`); process.exit(2); }
const { TelegramClient, sessions, Api } = await import('telegram');
const quiet = (c) => { if (c.setLogLevel) c.setLogLevel('none'); return c; };
const said = (e) => String((e && (e.errorMessage || e.message)) || e).slice(0, 160);

async function done(client) {
  put(f.session, client.session.save());
  const me = await client.getMe().catch(() => null);
  console.log(`session written to ${f.session}${me && me.username ? ` (account @${me.username})` : ''}; restart arena-faucet and arena-bounty-bots to use it`);
  await client.disconnect(); process.exit(0);
}

if (arg('--phone')) {
  // STEP 1: ask Telegram for the login code; keep the connection's session and the code hash for step 2
  const phone = arg('--phone');
  const client = quiet(new TelegramClient(new sessions.StringSession(''), apiId, apiHash, { connectionRetries: 3 }));
  await client.connect();
  try {
    const sent = await client.sendCode({ apiId, apiHash }, phone);
    put(PENDING, JSON.stringify({ phone, phoneCodeHash: sent.phoneCodeHash, session: client.session.save(), atMs: Date.now() }));
    console.log(`the login code was sent (${sent.isCodeViaApp ? 'in the Telegram app' : 'by SMS'}); now run: node tools/telegram-userbot-login.mjs --code <code>`);
  } catch (e) { console.error(`not sent: ${said(e)}`); process.exitCode = 1; }
  await client.disconnect(); process.exit();
} else if (arg('--code')) {
  // STEP 2: sign in with the code (and the 2FA password when the account has one)
  let p; try { p = JSON.parse(readFileSync(PENDING, 'utf8')); } catch { console.error('no login in progress: run with --phone first'); process.exit(2); }
  const client = quiet(new TelegramClient(new sessions.StringSession(p.session), apiId, apiHash, { connectionRetries: 3 }));
  await client.connect();
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: String(arg('--code')) }));
  } catch (e) {
    if (said(e).includes('SESSION_PASSWORD_NEEDED')) {
      const pw = arg('--password');
      if (!pw) { console.error('this account has a 2FA password: run again with --code <code> --password <password>'); await client.disconnect(); process.exit(3); }
      try { await client.signInWithPassword({ apiId, apiHash }, { password: async () => pw, onError: (x) => { throw x; } }); } catch (x) { console.error(`not signed in: ${said(x)}`); await client.disconnect(); process.exit(1); }
    } else { console.error(`not signed in: ${said(e)}`); await client.disconnect(); process.exit(1); }
  }
  renameSync(PENDING, `${PENDING}.used-${stamp()}`);
  await done(client);
} else {
  const rl = createInterface({ input: stdin, output: stdout });
  const client = quiet(new TelegramClient(new sessions.StringSession(''), apiId, apiHash, { connectionRetries: 3 }));
  await client.start({
    phoneNumber: () => rl.question('Phone number (international, +49...): '),
    phoneCode: () => rl.question('Login code from Telegram: '),
    password: () => rl.question('2FA password (empty if none): '),
    onError: (e) => console.error(said(e)),
  });
  rl.close();
  await done(client);
}
