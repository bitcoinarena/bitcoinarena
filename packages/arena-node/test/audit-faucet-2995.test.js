// kanban #2995 (audit faucet r2-2): THE SEASON 2 DOORS COME THROUGH THE SITE WORKER WITHOUT THE CALLER'S ADDRESS. src/website/worker.js passes POST
// /api/faucet/feedback/{link,verify,social} on with content-type, origin and authorization only - no x-arena-ip and no x-arena-worker (the general
// faucet proxy below it sends both, kanban #1434). The faucet's per-caller limit on link codes (#2666: S2_LINK_PER_CALLER_HOUR = 20 per ipKey an
// hour) then counts by ipOf(req) = the tunnel's last x-forwarded-for hop, which for every Worker subrequest is the Worker's own egress address -
// one "caller" for every reporter on the site. A stranger with 20 fresh NIP-98 keys takes the whole hour's link codes of every reporter.
// Safe: a second reporter (another cf-connecting-ip) still gets a link code after one stranger used up his own 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes, createHash } from 'node:crypto';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const BASE = 'https://bitcoinarena.io/api/faucet/feedback';
const sha3881 = (b) => createHash('sha256').update(String(b ?? '')).digest('hex');   // kanban #3881: a POST sign-in names its body's SHA-256 (payload) and each sign-in is taken once
const KEY = 'w'.repeat(48);
const WORKER_EGRESS = '2a06:98c0:3600::103';   // the address Cloudflare names for a Worker's subrequest
const auth = (body = '') => { const secret = randomBytes(32); const e = { pubkey: hex(schnorr.getPublicKey(secret)), created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND,
  tags: [['u', `${BASE}/link`], ['method', 'POST'], ['payload', sha3881(body)]], content: '' }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('audit-faucet-r2-2: one stranger through the site Worker does not use up every reporter\'s link codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-r2-2-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_DB: join(dir, 's2.db'), FAUCET_BOUNTY_S2_BASES: BASE, FAUCET_WORKER_KEY: KEY } });
  const origin = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  const seen = [];
  // the tunnel in front of the faucet: the request as the Worker sent it, plus the x-forwarded-for hop Cloudflare names (the Worker's egress)
  globalThis.fetch = async (u, init = {}) => {
    const h = new Headers(init.headers || {}); seen.push(Object.fromEntries(h.entries()));
    h.set('x-forwarded-for', WORKER_EGRESS);
    return realFetch(u, { ...init, headers: h });
  };
  try {
    for (let i = 0; i < 80; i++) { try { await realFetch(`${origin}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const worker = (await import('../../../src/website/worker.js')).default;
    const env = { FAUCET_ORIGIN: origin, FAUCET_WORKER_KEY: KEY };
    const ask = async (ip) => (await worker.fetch(new Request('https://bitcoinarena.io/api/faucet/feedback/link', { method: 'POST',
      headers: { authorization: auth(), 'cf-connecting-ip': ip, origin: 'https://testnet.bitcoinarena.io' } }), env, { waitUntil() {} })).json();
    let stranger = 0;
    for (let i = 0; i < 20; i++) { const r = await ask('198.51.100.66'); if (r.ok && r.code) stranger++; }
    const honest = await ask('203.0.113.5');
    console.log(`  MEASURED: stranger took ${stranger} codes; the next reporter (another address) answered ${JSON.stringify(honest).slice(0, 140)}; headers the Worker sent: ${Object.keys(seen[0] || {}).join(',')}`);
    assert.equal(stranger, 20, 'control: the stranger gets his own 20 codes');
    assert.ok(honest.ok && honest.code, `another reporter is refused a link code because the stranger used up the Worker's one shared address: ${honest.why}`);
  } finally { globalThis.fetch = realFetch; faucet.kill(); }
});


test('#2995 the stage Worker passes the caller\'s address and its key on the Season 2 doors too', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (u, init = {}) => { sent.push(Object.fromEntries(new Headers(init.headers || {}).entries())); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const worker = (await import('../../../src/website-stage/worker.js')).default;
    const env = { FAUCET_ORIGIN: 'http://faucet.invalid', FAUCET_WORKER_KEY: KEY };
    for (const door of ['link', 'verify', 'social']) {
      await worker.fetch(new Request(`https://testnet-stage.bitcoinarena.io/api/faucet/feedback/${door}`, { method: 'POST', body: '{}',
        headers: { authorization: auth('{}'), 'cf-connecting-ip': '203.0.113.9' } }), env, { waitUntil() {} });
    }
    assert.equal(sent.length, 3);
    for (const h of sent) { assert.equal(h['x-arena-ip'], '203.0.113.9'); assert.equal(h['x-arena-worker'], KEY); }
  } finally { globalThis.fetch = realFetch; }
});
