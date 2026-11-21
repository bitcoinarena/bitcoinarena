// kanban #2996 (audit faucet r2-3): THE #2646 FIX IS ONE SHARED MINUTE ANYONE CAN TAKE. POST /feedback/social (and /feedback/verify) take a slot of
// S2_LIVE_ALL (FAUCET_BOUNTY_S2_LIVE_MINUTE, default 4 a minute, all callers together) before any read, and the only other limit is per NIP-98 key
// (15 s) - a key costs nothing. So one stranger sending 4 sign-ins a minute, each with a fresh key, holds every slot: every real reporter's social
// check (the Season 2 bonus and the draw entry) is answered "too many checks right now" for as long as he goes on. No per-caller share exists
// (and through the site/stage Workers the faucet sees no caller address at all).
// Safe: a reporter's check is not refused because one other caller made 4 asks this minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const BASE = 'https://stage.example/api/faucet/feedback';
const auth = () => { const secret = randomBytes(32); const e = { pubkey: hex(schnorr.getPublicKey(secret)), created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND,
  tags: [['u', `${BASE}/social`], ['method', 'POST']], content: '' }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('audit-faucet-r2-3: four fresh-key asks from one stranger do not refuse every reporter\'s social check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-r2-3-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_DB: join(dir, 's2.db'), FAUCET_BOUNTY_S2_BASES: BASE, FAUCET_BOUNTY_NOSTR: 'off' } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${origin}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ask = async (xff, body) => (await fetch(`${origin}/feedback/social`, { method: 'POST', headers: { authorization: auth(), 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify(body) })).json();
    const stranger = [];
    for (let i = 0; i < 4; i++) stranger.push(await ask('198.51.100.66', { x: `nobody${i}` }));
    const honest = await ask('203.0.113.5', { x: 'realreporter', telegram: 'realreporter' });
    console.log(`  MEASURED: stranger asks ${stranger.map((r) => (r.ok ? 'ok' : r.why)).join(' | ')}; the reporter: ${JSON.stringify(honest).slice(0, 160)}`);
    // kanban #2996: one address takes at most its share of the minute (two slots of four); the rest of its asks are refused, nothing read
    assert.ok(stranger[0].ok && stranger[1].ok, 'control: the stranger\'s first two asks took a slot each');
    assert.ok(stranger.slice(2).every((r) => !r.ok && /from this address/.test(r.why)), 'the stranger\'s other asks are over his share');
    assert.ok(honest.ok, `a real reporter (another address, his own key) is refused his social check: ${honest.why}`);
  } finally { faucet.kill(); }
});

