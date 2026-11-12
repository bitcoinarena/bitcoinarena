// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1535 (variant: a second caller). The cap is 2 rows per ipKey, and an IPv6 caller is keyed by its /64; any home
// line holds a /56 (256 /64s). Two /64s of one attacker re-posting 4 made-up rounds keep the real table out of the 4 rows rps-opponent reads,
// through the real POST /opponent door with the Worker's key - exactly the original attack, with a second address.
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
test('#1489 refute-42-s1-1: two /64s of one attacker push the real table out of the opponent\'s 4 reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489rf42-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const want = async (round, ip) => (await (await fetch(`http://127.0.0.1:${port}/opponent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip, 'x-arena-worker': KEY }, body: JSON.stringify({ round, tapped: true }) })).json());
    const real = 'ab'.repeat(32);
    await want(real, '198.51.100.20');
    const ips = ['2001:db8:66:1::1', '2001:db8:66:2::1'];   // one /56, two /64s
    const junk = [1, 2, 3, 4].map((n) => String(n).repeat(64));
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 4; i++) { await sleep(5); await want(junk[i], ips[i % 2]); }
    const list = (await (await fetch(`http://127.0.0.1:${port}/opponent`)).json()).wants;
    const read = list.slice(0, 4).map((w) => w.round);
    console.log('  MEASURED:', JSON.stringify({ listed: list.length, botReads: read.map((r) => r.slice(0, 4)), realRead: read.includes(real) }));
    assert.ok(read.includes(real), 'the real player\'s table is among the 4 the opponent reads');
  } finally { child.kill(); }
});
