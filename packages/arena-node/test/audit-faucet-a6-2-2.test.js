// kanban #3366: the card's test (audit faucet a6-2-2)
// audit faucet r2 (a6-2-2): THE HOUR'S LINK CODES ARE ONE POOL THIRTY /64s EMPTY. POST /feedback/link (faucet.mjs) counts a caller by its ipKey
// (an IPv6 /64) - S2_LINK_PER_CALLER_HOUR = 20 - and all callers together S2_LINK_PER_HOUR = 600, with no bound per network. A key costs nothing,
// so one stranger with 30 /64s of his own /48 (a home line holds 256) signs in with a fresh key per request, takes all 600 codes of the hour,
// and every real reporter asking for his Season 2 link code is answered "too many link codes this hour" until the hour turns - again each hour.
// #2995 gave the faucet the caller's address so one address could not do it; the per-network bound every other global faucet cap has
// (#2539, #2757, #1679 /48 and /24 shares) is missing here.
// Safe: a reporter on another network still gets his link code after one stranger's /48 asked for 600 this hour.
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
  tags: [['u', `${BASE}/link`], ['method', 'POST']], content: '' }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('audit-faucet-a6-2-2: thirty /64s of one stranger\'s /48 do not take every reporter\'s link code for the hour', async () => {
  // not across an hour boundary: the count resets when the hour turns
  const left = 3600000 - (Date.now() % 3600000); if (left < 60000) await new Promise((r) => setTimeout(r, left + 500));
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-a6-2-2-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_DB: join(dir, 's2.db'), FAUCET_BOUNTY_S2_BASES: BASE, FAUCET_BOUNTY_NOSTR: 'off' } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${origin}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ask = async (xff) => { const r = await fetch(`${origin}/feedback/link`, { method: 'POST', headers: { authorization: auth(), 'content-type': 'application/json', 'x-forwarded-for': xff }, body: '{}' });
      return { status: r.status, ...(await r.json()) }; };
    let took = 0;
    for (let n = 1; n <= 30; n++) for (let i = 0; i < 20; i++) { const r = await ask(`2001:db8:aaaa:${n.toString(16)}::1`); if (r.ok && r.code) took++; }
    const honest = await ask('203.0.113.5');
    console.log(`  MEASURED: the stranger's /48 took ${took} link codes; the reporter: ${JSON.stringify(honest).slice(0, 140)}`);
    assert.ok(took > 0 && took < 600, 'control: the stranger took codes, and not the whole hour (one network takes at most its share, kanban #3366)');
    assert.ok(honest.ok && honest.code, `a real reporter (another network, his own key) gets no link code this hour: ${honest.status} ${honest.why}`);
  } finally { faucet.kill(); }
});
