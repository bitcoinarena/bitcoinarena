// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-faucet-2 (2026-11-14): POST /feedback/social (the stage Worker passes it on to the faucet, no caller address) reads each typed
// name LIVE - X through the team's logged-in X browser session (friendships/show), Discord with the bot token, Telegram with the user account
// reader. Its only limit is S2_SOCIAL_ASKS: one check per 15 s per SIGNED-IN KEY. A NIP-98 sign-in costs nothing (a fresh key per request), so one
// stranger makes the faucet read X (and Discord, Telegram) as often as they like: X locks the account's reads (its limits are per 15 min) and every
// real reporter's bonus check fails or waits behind spaced(3000)'s queue.
// Measured here as the X browser session reads (each live X check reads the session first): 30 fresh keys in one burst.
// Safe: the live reads of all callers together are bounded - a burst of fresh keys does not make one X read each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const freshKey = () => { const secret = randomBytes(32); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const STAGE = 'https://stage.example/api/faucet/feedback';

test('#1489 r1-faucet-2: fresh sign-in keys do not each buy a live X read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r1-faucet-2-'));
  writeFileSync(join(dir, 'token'), 'x');
  // the "X browser": its debug port answers nothing usable, so no request leaves this machine - each hit is one live X check begun
  let sessionReads = 0;
  const xBrowser = createServer((req, res) => { sessionReads++; req.resume(); res.writeHead(503); res.end('busy'); });
  await new Promise((r) => xBrowser.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'),
      FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_S2_DB: join(dir, 'season2.db'), FAUCET_BOUNTY_S2_BASES: STAGE,
      FAUCET_BOUNTY_X_PORT: String(xBrowser.address().port), FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ask = (k) => fetch(`${base}/feedback/social`, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Nostr ${Buffer.from(JSON.stringify(signed(k, HTTP_AUTH_KIND, [['u', `${STAGE}/social`], ['method', 'POST']]))).toString('base64')}` },
      body: JSON.stringify({ x: 'bitcoin' }) }).then((r) => r.json());
    const answers = await Promise.all(Array.from({ length: 30 }, () => ask(freshKey())));
    const checked = answers.filter((a) => a && a.ok && a.results && a.results.x).length;
    console.log('  MEASURED r1-faucet-2:', JSON.stringify({ requests: 30, answeredWithAnXCheck: checked, xSessionReads: sessionReads }));
    assert.ok(sessionReads <= 4, `30 fresh keys in one burst made ${sessionReads} live X checks`);
  } finally { faucet.kill(); xBrowser.close(); }
});
