// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit44 refute of #1679 (skeptic 2), the RETRY path: the store keeps a signed report once per event id ("a second post of the same event
// answers the first", kept: false), but tools/faucet.mjs books a new slot in REPORTS for every post and posts the words to the chat again. A page that
// sends its report again (a lost answer, a reload) or anyone holding the event posts it 60 times: 50 chat posts of one report, the address's day used up,
// and the reporter's next, different signed report is refused - "counted once" (#1426) does not hold for a resend.
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
import { FEEDBACK_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#1489-a44-45-s2 the same signed report sent again is counted and posted again, and the reporter\'s next report is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489a4445s2-'));
  const chat = [];
  const chatServer = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { chat.push(JSON.parse(b).text); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = async (body) => (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '198.51.100.7' }, body: JSON.stringify(body) })).json();
    const alice = key(7);
    const report = signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['build', 'UI 577']], JSON.stringify({ happened: 'The deposit screen stays on waiting after the payment went through' }));
    const first = await post({ event: report });
    const again = [];
    for (let i = 0; i < 60; i++) again.push(await post({ event: report }));
    const next = await post({ event: signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['build', 'UI 577']], JSON.stringify({ happened: 'The lobby list is empty after a reload of the page' })) });
    const sameWords = chat.filter((t) => t.includes('stays on waiting')).length;
    console.log('  MEASURED:', JSON.stringify({ first: [first.ok, first.kept, first.number], resendsTaken: again.filter((r) => r.ok).length, chatPostsOfOneReport: sameWords, next }));
    assert.equal(sameWords, 1, `one signed report reaches the chat once (got ${sameWords} posts)`);
    assert.equal(next.ok, true, `the reporter's second, different report is taken (got: ${next.why})`);
  } finally { faucet.kill(); chatServer.close(); }
});
