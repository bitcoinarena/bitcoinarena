// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1985, copied unchanged to 1.9 by #2536 (wf1489-sm5-faucet-2): red on f5bdcca16 - send1/send2 502 "could not be kept", the store held #001 and #002.
// KANBAN #1489 state machine audit, round 5, faucet: POST /feedback keeps a signed report (FEEDBACK.take: a row, its number, counted) BEFORE the
// Arena Chat post, and answers 502 "the report could not be kept just now" when the chat post fails. The answer lies about the effect: the report
// IS kept. The page (src/arena-ui/index.html) shows the why, enables Send again, and Send signs a NEW event (new created_at, new debug) - a second
// kept report with the next number for the same bug, both in My feedback and in the review list, both counted toward the address's limit.
// The real tools/faucet.mjs as a process, a chat stand-in that answers 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '', at = Math.floor(Date.now() / 1000)) => { const e = { pubkey: k.pubkey, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const MINE = 'https://testnet.example/api/faucet/feedback/mine';

test('#1489 sm5-faucet-2: a report answered "could not be kept" is kept, and the page\'s second Send keeps it twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm5-faucet-2-'));
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(500); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = async (body) => { const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.0.0.9' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
    const alice = key(3);
    const words = JSON.stringify({ happened: 'The reveal never came back after the countdown reached zero in the lobby', expected: 'the result' });
    const now = Math.floor(Date.now() / 1000);
    const send1 = await post({ event: signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['build', 'UI 633']], words, now) });
    // the page: the why shown, Send enabled again; the second Send signs the same words anew
    const send2 = await post({ event: signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['build', 'UI 633']], words, now + 1) });
    const mine = await (await fetch(`${base}/feedback/mine`, { headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]))).toString('base64')}` } })).json();
    const facts = { send1: [send1.status, send1.why], send2: [send2.status, send2.why], kept: (mine.reports || []).map((r) => [r.label, r.state]) };
    console.log('  MEASURED #1489 sm5-faucet-2:', JSON.stringify(facts));
    // kanban #1985: the store is the record - a kept report is answered kept, with its number, even while its chat line does not go out
    assert.equal(send1.status, 200); assert.equal(send1.ok, true); assert.equal(send1.label, 'Feedback #001'); assert.equal(send1.posted, false);
    // what the door answered must be what it did: as many kept reports as answers that said kept
    assert.equal(facts.kept.length, [send1, send2].filter((x) => x.ok).length, 'the door answered "could not be kept" twice, yet the store holds the report as two numbered reports');
  } finally { faucet.kill(); chatServer.close(); }
});

test('#1985: with the chat unreachable a signed report is answered kept once, an unsigned one (nothing kept) still 502', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm5-faucet-2b-'));
  const dead = createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${deadPort}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = async (body) => { const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.0.0.8' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
    const bob = key(4);
    const ev = signed(bob, FEEDBACK_KIND, [['t', 'bug'], ['build', 'UI 633']], JSON.stringify({ happened: 'The market price froze after the second block and never moved again', expected: 'a live price' }));
    const a = await post({ event: ev });
    const again = await post({ event: ev });   // the same event resent: the store already holds it
    const unsigned = await post({ text: 'The board shows the wrong count of rounds in the lobby list today', build: 'UI 633' });
    const mine = await (await fetch(`${base}/feedback/mine`, { headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(signed(bob, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]))).toString('base64')}` } })).json();
    console.log('  MEASURED #1985:', JSON.stringify({ a: [a.status, a.label, a.kept], again: [again.status, again.label, again.kept], unsigned: [unsigned.status, unsigned.why], kept: (mine.reports || []).map((r) => r.label) }));
    assert.deepEqual([a.status, a.ok, a.label, a.kept], [200, true, 'Feedback #001', true]);
    assert.deepEqual([again.status, again.ok, again.label, again.kept], [200, true, 'Feedback #001', false]);
    assert.equal(unsigned.status, 502);
    assert.deepEqual((mine.reports || []).map((r) => r.label), ['Feedback #001']);
  } finally { faucet.kill(); }
});
