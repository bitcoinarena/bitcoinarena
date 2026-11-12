// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 (a45 refute of #1808, skeptic 2): A REPORT THE CHAT TOOK BUT ANSWERED LATE IS GIVEN BACK. POST /feedback holds an unsigned report's
// slot before its chat post (#1808) and gives it back when the post throws - the 10 s AbortSignal timeout too. The chat had the whole body by then
// and posted it; the faucet answers 400 "not JSON" and frees the slot. With the chat slow (load, a stalled reply), one address gets
// FEEDBACK_PER_IP_PER_DAY posts per 10 s instead of per day. Safe: a post that may have gone out stays counted.
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
test('#1489 a45-s2 a report the chat posted but answered after the 10 s timeout stays counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a45s2r1-'));
  writeFileSync(join(dir, 'token'), 'chat-token');
  let posts = 0;
  // the message is in the channel as soon as its body is in; the answer comes after the faucet's 10 s
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { posts += 1; setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch {} }, 10500); }); });
  await new Promise((ok) => chat.listen(0, '127.0.0.1', ok));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_FOUNDING_STATE: join(dir, 'founding-state.json') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const send = async (n) => { const r = await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arena-ip': '203.0.113.67', 'x-arena-worker': KEY },
      body: JSON.stringify({ text: `stranger message number ${n}, the same address every time` }) }); return { status: r.status, ...(await r.json()) }; };
    const answers = [];
    for (let burst = 0; burst < 3; burst++) answers.push(...await Promise.all(Array.from({ length: FEEDBACK_PER_IP_PER_DAY + 10 }, (_, n) => send(burst * 100 + n))));
    console.log('  MEASURED:', JSON.stringify({ sent: answers.length, chatPosts: posts, perIpPerDay: FEEDBACK_PER_IP_PER_DAY,
      answers: Object.fromEntries([...new Set(answers.map((a) => `${a.status} ${a.why}`))].map((k) => [k, answers.filter((a) => `${a.status} ${a.why}` === k).length])) }));
    assert.ok(posts <= FEEDBACK_PER_IP_PER_DAY, `one address put ${posts} reports into the chat, the limit is ${FEEDBACK_PER_IP_PER_DAY} a day`);
  } finally { child.kill(); chat.close(); }
});
