// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit44 refute of #1679: ONE /64 STILL CLOSES THE FEEDBACK DOOR, BY A BURST. POST /feedback decides (feedbackDecide over REPORTS) and only
// pushes the report into REPORTS after the chat post came back. Requests sent at once all decide against the same REPORTS, so the per-/64 (50), per-/48
// (100), FEEDBACK_PER_DAY and FEEDBACK_FIRST_RESERVE bounds are all read before any of them is counted: one address sends 2100 reports at once, ~1500 are
// taken (as many chat posts), a second address's burst takes the rest of the 2000, and every later report of the day - an honest address's first one included - is refused.
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

test('#1489-a44-45 one /64 bursting reports at once fills the whole day and shuts out an honest first report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489a4445-'));
  let posted = 0;
  // the chat answers after 300 ms (a remote server over the network)
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { posted++; setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 300); }); });
  await new Promise((ok) => chat.listen(0, '127.0.0.1', ok));
  writeFileSync(join(dir, 'chat-token'), 'test-token\n');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat-token'), FAUCET_CHAT_CHANNEL: 'feedback',
    FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const send = async (ip, text) => { try { return await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip, 'x-arena-worker': KEY, origin: 'https://evil.example' },
      body: JSON.stringify({ text }) })).json(); } catch (e) { return { ok: false, why: String(e) }; } };
    // ONE address, all at once
    const batch = await Promise.all(Array.from({ length: 2100 }, (_, i) => send('2001:db8:66:1::1', `junk ${i}`)));
    const took = batch.filter((r) => r.ok).length;
    // and if the first burst fell short of the day plus the reserve, a second address (its own /48, its first report) bursts the rest
    const batch2 = await Promise.all(Array.from({ length: 1200 }, (_, i) => send('2001:db8:77:1::1', `junk b ${i}`)));
    const took2 = batch2.filter((r) => r.ok).length;
    const honest = await send('198.51.100.7', 'The deposit screen stays on "waiting" after the payment went through.');
    console.log('  MEASURED:', JSON.stringify({ oneAddressReportsTaken: took, secondAddressReportsTaken: took2, chatPosts: posted, honest }));
    assert.ok(took <= 50, `one /64 is taken at most 50 reports a day (got ${took})`);
    assert.equal(honest.ok, true, `an honest address's first report of the day is taken (got: ${honest.why})`);
  } finally { child.kill(); chat.close(); }
});
