// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit faucet a7-1-1: the owner's review list (GET /feedback/admin/list?lite=1, what www/feedback-admin/index.html reads; its filters run on the
// page over that one read) is FEEDBACK.list() with its default LIMIT 500, newest first. Any later 500 signed reports - fresh keys cost nothing, five
// IPv4 /24s stay under every per-network day limit of POST /feedback - push an honest report that still waits for review out of the list: the
// owner never sees it and its bounty is never approved. Safe behaviour: a report in state 'new' is always on the review list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const secret = createHash('sha256').update(`a7-1-1 key ${n}`).digest(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, content) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']], content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const ADMIN = 'admin-code-a7-1-1';

test('audit faucet a7-1-1: an honest report waiting for review stays on the admin review list after 500 later reports', { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-a7-1-1-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
    FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_WORKER_KEY: '' };
  const base = `http://127.0.0.1:${port}`;
  const post = (event, ip) => fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ event }) }).then((r) => r.json());
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore', env });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const honest = signed(keyOf('honest'), JSON.stringify({ happened: 'The settlement of my round never arrived although the round was ACCEPTED at every seat', expected: 'my payout' }));
    const h = await post(honest, '192.0.2.10');
    assert.equal(h.ok && h.kept, true, `the honest report is kept: ${JSON.stringify(h)}`);
    // the stranger: 500 signed reports, fresh keys, 100 from each of five IPv4 /24s (FEEDBACK_PER_24_PER_DAY), 50 per address (FEEDBACK_PER_IP_PER_DAY)
    let kept = 0;
    for (let i = 0; i < 500; i++) {
      const net = 10 + Math.floor(i / 100), host = 1 + Math.floor((i % 100) / 50);
      const e = signed(keyOf(i), JSON.stringify({ happened: `Filler report number ${i} with enough words to pass the fifty character minimum`, expected: 'nothing' }));
      const r = await post(e, `198.51.${net}.${host}`);
      if (r.ok && r.kept) kept++;
    }
    const list = await fetch(`${base}/feedback/admin/list?lite=1`, { headers: { 'x-arena-admin': ADMIN, 'x-forwarded-for': '192.0.2.10' } }).then((r) => r.json());
    const ids = new Set((list.reports || []).map((r) => r.id));
    const facts = { strangerReportsKept: kept, listed: ids.size, honestListed: ids.has(honest.id) };
    console.log('FACTS', JSON.stringify(facts));
    assert.equal(kept, 500, 'the stranger\'s reports all pass POST /feedback\'s day limits');
    assert.ok(ids.has(honest.id), `the honest report (state new, waiting for review) is not on the owner's review list any more: ${JSON.stringify(facts)}`);
  } finally { faucet.kill(); chat.close(); }
});

// kanban #3573, the store's own rule: the limit bounds only decided reports; every waiting one (new, or accepted with its reward not paid) stays listed
import { openFeedbackStore } from '../src/feedback-store.js';
test('#3573 list(): every new or accepted report is listed whatever the limit; decided reports keep the newest-first limit', () => {
  const s = openFeedbackStore();
  const t0 = Date.now();
  const take = (n, at) => { const e = signed(keyOf(`store ${n}`), JSON.stringify({ happened: `Store report number ${n} with enough words to pass the fifty character minimum`, expected: '' }));
    assert.equal(s.take(e, { nowMs: at }).ok, true); return e.id; };
  const waiting = take('waiting', t0), approved = take('approved', t0 + 1);
  assert.equal(s.approve(approved, 500, { played: () => true }).ok, true);
  const decided = [];
  for (let i = 0; i < 6; i++) { const id = take(i, t0 + 10 + i); assert.equal(s.move(id, 'rejected', { reason: 'filler' }).ok, true); decided.push(id); }
  const ids = s.list({ limit: 3 }).map((r) => r.id);
  assert.deepEqual(ids, [...decided.slice(3).reverse(), approved, waiting], 'the 3 newest decided reports, then every waiting one, newest first');
  assert.deepEqual(s.list({ state: 'new', limit: 1 }).map((r) => r.id), [waiting]);
  assert.deepEqual(s.list({ state: 'rejected', limit: 2 }).map((r) => r.id), decided.slice(4).reverse());
});
