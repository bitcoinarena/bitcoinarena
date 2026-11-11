// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2: THE TEST OPPONENT'S TABLE LIST IS ANY STRANGER'S. POST /opponent { round } takes any 64-hex round from anyone, unsigned,
// with no per-caller limit, and GET /opponent lists the newest first; tools/rps-opponent.mjs reads only wants.slice(0, 4) (and contractOf of a
// made-up round throws, failing its whole pass). One caller re-posting 4 rounds every second keeps every real player's table out of the 4 the bot
// reads: nobody gets an opponent. Safe: a real player's table stays among the first 4 the bot reads, whatever one other caller posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
test('#1489-r2 one stranger cannot push every real table out of the test opponent\'s reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r2f4-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const want = async (round, ip) => (await (await fetch(`http://127.0.0.1:${port}/opponent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip, 'x-arena-worker': KEY }, body: JSON.stringify({ round, tapped: true }) })).json());
    const junk = [1, 2, 3, 4].map((n) => String(n).repeat(64));
    const real = 'ab'.repeat(32);
    await want(real, '198.51.100.20');   // a real page at its table
    for (let pass = 0; pass < 3; pass++) { for (const r of junk) { await sleep(5); await want(r, '203.0.113.66'); } }   // the stranger, again and again
    const list = (await (await fetch(`http://127.0.0.1:${port}/opponent`)).json()).wants;
    const read = list.slice(0, 4).map((w) => w.round);   // what tools/rps-opponent.mjs reads
    console.log('  MEASURED:', JSON.stringify({ listed: list.length, botReads: read.map((r) => r.slice(0, 4)), realRead: read.includes(real) }));
    assert.ok(read.includes(real), 'the real player\'s table is among the 4 the opponent reads');
  } finally { child.kill(); }
});
