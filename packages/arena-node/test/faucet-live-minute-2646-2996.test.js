// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2646 + #2996 (2.0 port of 1.9 8fbfaf2d8 + c6bbef345): POST /feedback/verify reads the reporter's linked accounts LIVE. A NIP-98 key
// costs nothing, so a fresh key per request bought one live read each. Now all callers share one minute of FAUCET_BOUNTY_S2_LIVE_MINUTE (4)
// live checks, and one caller (its address) takes at most FAUCET_BOUNTY_S2_LIVE_PER_CALLER (2) of them. 2.0 has no /feedback/social door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const freshKey = () => { const secret = randomBytes(32); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const STAGE = 'https://stage.example/api/faucet/feedback';

async function burst(extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-2646-'));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'),
      FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_S2_DB: join(dir, 'season2.db'), FAUCET_BOUNTY_S2_BASES: STAGE,
      FAUCET_BOUNTY_X_PORT: '1', FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), ...extraEnv } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    // kanban #3881: a POST sign-in names its body's SHA-256 (payload)
    const ask = (k) => fetch(`${base}/feedback/verify`, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Nostr ${Buffer.from(JSON.stringify(signed(k, HTTP_AUTH_KIND, [['u', `${STAGE}/verify`], ['method', 'POST'], ['payload', createHash('sha256').update('{}').digest('hex')]]))).toString('base64')}` },
      body: '{}' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    return await Promise.all(Array.from({ length: 30 }, () => ask(freshKey())));
  } finally { faucet.kill(); }
}

test('#2646 #2996 2.0: 30 fresh keys from one address get 2 live checks, the rest "too many checks from this address"', async () => {
  const answers = await burst({});
  const live = answers.filter((a) => a.status !== 429).length;
  const mine = answers.filter((a) => a.status === 429 && /from this address/.test(a.body.why || '')).length;
  console.log('  MEASURED #2996:', JSON.stringify({ requests: 30, live, refusedPerCaller: mine }));
  assert.equal(live, 2);
  assert.equal(mine, 28);
});

test('#2646 2.0: with a large per-caller share the shared minute still holds all callers to 4 live checks', async () => {
  const answers = await burst({ FAUCET_BOUNTY_S2_LIVE_PER_CALLER: '100' });
  const live = answers.filter((a) => a.status !== 429).length;
  console.log('  MEASURED #2646:', JSON.stringify({ requests: 30, live }));
  assert.equal(live, 4);
  assert.ok(answers.filter((a) => a.status === 429).every((a) => /too many checks right now/.test(a.body.why || '')));
});
