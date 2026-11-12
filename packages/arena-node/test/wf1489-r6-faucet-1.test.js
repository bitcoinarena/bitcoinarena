// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 6: AN UNSIGNED REPORT IS COUNTED ONLY AFTER ITS CHAT POST CAME BACK. POST /feedback without an event runs feedbackDecide
// against REPORTS, awaits the Arena Chat post, and only then pushes the report into REPORTS. One address sending its reports at once has every one
// of them pass the check while none is counted yet: FEEDBACK_PER_IP_PER_DAY (50) and FEEDBACK_PER_DAY (1000) never trip, and one caller posts
// as many stranger's messages into #feedback (and lines into the founding file) as it sends in one burst. The #1424 fix ("counted when kept")
// covered signed reports only. Safe: one address gets at most FEEDBACK_PER_IP_PER_DAY reports into the chat in a day, sent at once or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_PER_IP_PER_DAY } from '../src/faucet.js';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
test('#1489-r6 one address cannot get past the per-address report limit by sending its reports at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r6f1-'));
  writeFileSync(join(dir, 'token'), 'chat-token');
  let posts = 0;
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { posts += 1; setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 600); }); });
  await new Promise((ok) => chat.listen(0, '127.0.0.1', ok));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_FOUNDING_STATE: join(dir, 'founding-state.json') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const send = async (n) => (await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arena-ip': '203.0.113.66', 'x-arena-worker': KEY },
      body: JSON.stringify({ text: `stranger message number ${n}, the same address every time` }) })).json());
    const burst = 3 * FEEDBACK_PER_IP_PER_DAY;
    const answers = await Promise.all(Array.from({ length: burst }, (_, n) => send(n)));
    const taken = answers.filter((a) => a.ok).length;
    console.log('  MEASURED:', JSON.stringify({ sent: burst, taken, chatPosts: posts, perIpPerDay: FEEDBACK_PER_IP_PER_DAY }));
    assert.ok(posts <= FEEDBACK_PER_IP_PER_DAY, `one address put ${posts} reports into the chat, the limit is ${FEEDBACK_PER_IP_PER_DAY} a day`);
  } finally { child.kill(); chat.close(); }
});
