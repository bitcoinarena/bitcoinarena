// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1434 (audit 8): the faucet took x-arena-ip from any caller, so one machine could pass for many and beat every per-address limit.
// Now the header counts only with the Worker's key (FAUCET_WORKER_KEY); any other caller is the address the tunnel added last.
// 2.0 (kanban #1489): 2.0's faucet has no /feedback/lnaddress door, so the per-address limit measured is the one of POST /feedback.
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
test('#1434 a spoofed x-arena-ip without the Worker key does not reset the per-address limit; with the key it does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet1434-'));
  writeFileSync(join(dir, 'chat-token'), 'test-token\n');
  // a stand-in chat the reports go to
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
  await new Promise((ok) => chat.listen(0, '127.0.0.1', ok));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { cwd: dir, env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: 'c',
    FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat-token'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (headers) => (await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST', headers, body: JSON.stringify({ text: 'a report' }) })).json());
    // a caller straight over the tunnel: the address's day of reports, each with a new made-up address, then one more
    for (let i = 0; i < FEEDBACK_PER_IP_PER_DAY; i++) assert.equal((await ask({ 'x-arena-ip': `10.0.0.${i}`, 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` })).ok, true);
    const spoofed = await ask({ 'x-arena-ip': '10.0.1.1', 'x-forwarded-for': '10.9.9.200, 203.0.113.7' });
    // the Worker naming a new address, with its key
    const viaWorker = await ask({ 'x-arena-ip': '198.51.100.9', 'x-arena-worker': KEY });
    const wrongKey = await ask({ 'x-arena-ip': '198.51.100.10', 'x-arena-worker': 'z'.repeat(64), 'x-forwarded-for': '203.0.113.7' });
    console.log('  MEASURED #1434:', JSON.stringify({ spoofed: spoofed.why, viaWorker: viaWorker.ok, wrongKey: wrongKey.why }));
    assert.match(String(spoofed.why), /sent all it can today/, 'made-up addresses from one tunnel caller share its limit');
    assert.equal(viaWorker.ok, true, 'the Worker\'s named address has its own limit');
    assert.match(String(wrongKey.why), /sent all it can today/, 'a wrong key is no key');
  } finally { child.kill(); chat.close(); }
});
