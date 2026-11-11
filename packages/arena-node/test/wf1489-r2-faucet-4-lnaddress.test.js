// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2: GET /feedback/lnaddress counts its 30 checks per 10 min by the RAW address (LN_ASKS.get(ip)), while every other faucet
// limit counts an IPv6 caller by its /64 (ipKey, #1405/#1424). One IPv6 line holds 2^64 addresses: every check fetches a URL the caller names
// (https://<any host>/.well-known/lnurlp/<name>, or the URL inside an LNURL), so the faucet is an unlimited fetcher of the caller's choice.
// Safe: 30 checks from one /64 in 10 minutes, then "too many checks", whatever the last 64 bits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ORIGIN = 'https://testnet.bitcoinarena.io', KEY = 'k'.repeat(64);
test('#1489-r2 the Lightning-address check counts an IPv6 caller by its /64', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r2f3-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_BOUNTY_ORIGINS: ORIGIN, FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (ip) => (await (await fetch(`http://127.0.0.1:${port}/feedback/lnaddress?a=x`, { headers: { origin: ORIGIN, 'x-arena-ip': ip, 'x-arena-worker': KEY } })).json());
    // the site Worker names cf-connecting-ip: 40 addresses of ONE /64
    let refused = 0;
    for (let i = 1; i <= 40; i++) { const r = await ask(`2001:db8:1:2::${i.toString(16)}`); if (/too many checks/.test(String(r.why))) refused++; }
    console.log('  MEASURED: refused of 40 checks from one /64:', refused);
    assert.ok(refused >= 10, `one /64 made ${40 - refused} checks in a row (limit 30)`);
  } finally { child.kill(); }
});
