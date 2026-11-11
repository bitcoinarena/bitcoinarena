// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1434 (audit 8): the faucet took x-arena-ip from any caller, so one machine could pass for many and beat every per-address limit.
// Now the header counts only with the Worker's key (FAUCET_WORKER_KEY); any other caller is the address the tunnel added last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ORIGIN = 'https://testnet.bitcoinarena.io', KEY = 'k'.repeat(64);
test('#1434 a spoofed x-arena-ip without the Worker key does not reset the per-address limit; with the key it does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet1434-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_BOUNTY_ORIGINS: ORIGIN, FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (headers) => (await (await fetch(`http://127.0.0.1:${port}/feedback/lnaddress?a=x`, { headers: { origin: ORIGIN, ...headers } })).json());
    // a caller straight over the tunnel: 30 checks, each with a new made-up address, then the 31st
    for (let i = 0; i < 30; i++) await ask({ 'x-arena-ip': `10.0.0.${i}`, 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` });
    const spoofed = await ask({ 'x-arena-ip': '10.0.1.1', 'x-forwarded-for': '10.9.9.200, 203.0.113.7' });
    // the Worker naming a new address, with its key
    const viaWorker = await ask({ 'x-arena-ip': '198.51.100.9', 'x-arena-worker': KEY });
    const wrongKey = await ask({ 'x-arena-ip': '198.51.100.10', 'x-arena-worker': 'z'.repeat(64), 'x-forwarded-for': '203.0.113.7' });
    console.log('  MEASURED #1434:', JSON.stringify({ spoofed: spoofed.why, viaWorker: viaWorker.why, wrongKey: wrongKey.why }));
    assert.match(String(spoofed.why), /too many checks/, 'made-up addresses from one tunnel caller share its limit');
    assert.doesNotMatch(String(viaWorker.why), /too many checks/, 'the Worker\'s named address has its own limit');
    assert.match(String(wrongKey.why), /too many checks/, 'a wrong key is no key');
  } finally { child.kill(); }
});
