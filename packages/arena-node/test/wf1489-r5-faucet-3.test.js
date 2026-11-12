// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (faucet): ONE STRANGER CLOSES THE FEEDBACK DOOR FOR THE DAY. POST /feedback takes reports from any origin, unsigned ones too, and
// FEEDBACK_PER_DAY (1000) counts ALL callers together; the per-address limit (50, an IPv6 /64 as one) is the only other bound. Twenty /64s - one
// IPv6 /48 holds 65,536 - post 1000 throwaway reports and every later report of the day is refused, the signed bounty reports included: no player can
// file a bug (or claim a bounty for one) until midnight UTC. Safe: an honest address's first report of the day is still taken however many reports
// other addresses sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('#1489-r5 twenty addresses filling the day\'s report count do not shut out an honest reporter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r5f3-'));
  let posted = 0;
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { posted++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
  await new Promise((ok) => chat.listen(0, '127.0.0.1', ok));
  writeFileSync(join(dir, 'chat-token'), 'test-token\n');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat-token'), FAUCET_CHAT_CHANNEL: 'feedback',
    FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const send = async (ip, text) => (await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip, 'x-arena-worker': KEY, origin: 'https://evil.example' },
      body: JSON.stringify({ text }) })).json());
    let took = 0;
    for (let a = 0; a < 20; a++) {
      const batch = await Promise.all(Array.from({ length: 50 }, (_, i) => send(`2001:db8:66:${a.toString(16)}::${(i + 1).toString(16)}`, `junk ${a}-${i}`)));
      took += batch.filter((r) => r.ok).length;
    }
    const honest = await send('198.51.100.7', 'The deposit screen stays on "waiting" after the payment went through.');
    console.log('  MEASURED:', JSON.stringify({ strangerReportsTaken: took, chatPosts: posted, honest }));
    assert.equal(honest.ok, true, `an honest address's first report of the day is taken (got: ${honest.why})`);
  } finally { child.kill(); chat.close(); }
});
