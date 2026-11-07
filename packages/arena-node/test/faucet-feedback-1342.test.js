// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 slice 1, through the faucet itself: tools/faucet.mjs run as a process with a store in a temp folder and a stand-in for Arena Chat.
// An unsigned report goes to the chat as before and is not kept; a signed one goes to the chat and is kept; a forged one goes nowhere;
// GET /feedback/mine answers the reporter's NIP-98 sign-in for the configured URL and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const MINE = 'https://testnet.example/api/faucet/feedback/mine';

test('#1342 the faucet keeps a signed report, still posts every report to the chat, and answers "My feedback" to its reporter only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-1342-'));
  const chat = [];
  const chatServer = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { chat.push(JSON.parse(b).text); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = async (body) => (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.0.0.1' }, body: JSON.stringify(body) })).json();
    const alice = key(1), bob = key(2);
    const report = signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['game', 'rock-paper-scissors'], ['build', 'UI 577']], JSON.stringify({ happened: 'The reveal never came back', expected: 'the result' }));
    const unsigned = await post({ text: 'an old-style report, no key', build: 'UI 577' });
    const kept = await post({ event: report });
    const forged = await post({ event: { ...report, content: JSON.stringify({ happened: 'swapped words' }) } });
    const mine = async (ev) => { const r = await fetch(`${base}/feedback/mine`, { headers: ev ? { authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}` } : {} }); return { status: r.status, ...(await r.json()) }; };
    const own = await mine(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]));
    const bobs = await mine(signed(bob, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]));
    const wrongUrl = await mine(signed(alice, HTTP_AUTH_KIND, [['u', 'https://evil.example/feedback/mine'], ['method', 'GET']]));
    const none = await mine(null);
    const facts = { unsigned, kept, forged: forged.why, chatLines: chat.length, chatHasSignedWords: chat.some((t) => t.includes('The reveal never came back')),
      aliceSees: own.reports && own.reports.map((r) => [r.type, r.state, r.happened]), bobSees: bobs.reports && bobs.reports.length, wrongUrl: [wrongUrl.status, wrongUrl.why], none: [none.status, none.why] };
    console.log('  FACTS #1342 faucet:', JSON.stringify(facts));
    assert.deepEqual(unsigned, { ok: true });
    assert.deepEqual([kept.ok, kept.kept, kept.id], [true, true, report.id]);
    assert.ok(forged.why, 'a forged report was taken');
    assert.equal(chat.length, 2, 'the unsigned and the signed report reach the chat; the forged one does not');
    assert.ok(facts.chatHasSignedWords);
    assert.deepEqual(facts.aliceSees, [['bug', 'new', 'The reveal never came back']]);
    assert.equal(facts.bobSees, 0, 'another key sees none of hers');
    assert.equal(wrongUrl.status, 401);
    assert.equal(none.status, 401);
  } finally {
    faucet.kill(); chatServer.close(); rmSync(dir, { recursive: true, force: true });
  }
});
