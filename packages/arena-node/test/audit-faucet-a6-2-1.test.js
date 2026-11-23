// audit faucet r2 (a6-2-1): THE #2996 PER-CALLER SHARE IS HALF THE MINUTE. s2LiveSlot (faucet.mjs) gives each caller (its ipKey, an IPv6 /64)
// at most S2_LIVE_PER_CALLER = 2 of the S2_LIVE_MINUTE = 4 live-check slots a minute, all callers together. So a stranger with TWO /64s of his
// own /48 (any home line holds 256) - or two IPv4 addresses - takes all four slots every minute with fresh NIP-98 keys, and every real reporter's
// POST /feedback/social (and /feedback/verify) is answered "too many checks right now" again: the attack of #2996 with one more address.
// Safe: a reporter on another network is not refused his social check because one stranger's /48 asked 4 times this minute.
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
const auth = (door) => { const secret = randomBytes(32); const e = { pubkey: hex(schnorr.getPublicKey(secret)), created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND,
  tags: [['u', `${BASE}/${door}`], ['method', 'POST']], content: '' }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('audit-faucet-a6-2-1: two /64s of one stranger\'s /48 do not refuse every reporter\'s social check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-a6-2-1-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_DB: join(dir, 's2.db'), FAUCET_BOUNTY_S2_BASES: BASE, FAUCET_BOUNTY_NOSTR: 'off' } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${origin}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ask = async (xff, body, door = 'social') => (await fetch(`${origin}/feedback/${door}`, { method: 'POST', headers: { authorization: auth(door), 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify(body) })).json();
    // one stranger, one /48 (2001:db8:aaaa::/48), two of its /64s, two fresh keys each
    const stranger = [];
    for (const net of ['2001:db8:aaaa:1::1', '2001:db8:aaaa:2::1']) for (let i = 0; i < 2; i++) stranger.push(await ask(net, { x: `nobody${stranger.length}` }));
    const honest = await ask('203.0.113.5', { x: 'realreporter', telegram: 'realreporter' });
    const honestVerify = await ask('198.51.100.7', {}, 'verify');
    console.log(`  MEASURED: stranger asks ${stranger.map((r) => (r.ok ? 'ok' : r.why)).join(' | ')}; the reporter: ${JSON.stringify(honest).slice(0, 140)}; a verify: ${JSON.stringify(honestVerify).slice(0, 140)}`);
    assert.ok(stranger.every((r) => r.ok), 'control: each of the stranger\'s two /64s took its two slots (the #2996 share)');
    assert.ok(honest.ok, `a real reporter (another network, his own key) is refused his social check: ${honest.why}`);
    assert.ok(honestVerify.ok, `a real reporter's verify is refused: ${honestVerify.why}`);
  } finally { faucet.kill(); }
});
