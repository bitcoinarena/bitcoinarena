// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute 3 of #1537, measured through the faucet process itself: GET /feedback/lnaddress with an LNURL naming
// https://127.0.0.1.nip.io:<port>/ - a public spelling (any public DNS answers 127.0.0.1 for it) - passes publicHost, takes a counted slot, and the
// faucet opens a connection to a port on its own loopback. Each of the 120 checks a minute can name another port: the faucet probes and talks to
// its own local services ("could not be reached" / "did not answer in time" / "answered <status>" come back to the caller).
// Safe: no connection reaches the faucet host's loopback for a caller's address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ORIGIN = 'https://testnet.bitcoinarena.io', KEY = 'k'.repeat(64);
test('#1489 refute 3 #1537: the faucet\'s address check connects to its own loopback through a public spelling of 127.0.0.1', async () => {
  let connections = 0;
  const local = createServer((s) => { connections++; s.destroy(); });
  await new Promise((ok) => local.listen(0, '127.0.0.1', ok));
  const lp = local.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489v1r40s3-'));
  writeFileSync(join(dir, 'chat.token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_BOUNTY_ORIGINS: ORIGIN, FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: 'http://127.0.0.1:1', FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat.token'), FAUCET_CHAT_CHANNEL: 'c' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const hdr = { origin: ORIGIN, 'x-arena-ip': '2001:db8:9::1', 'x-arena-worker': KEY };
    const a = lnurlFor(`https://127.0.0.1.nip.io:${lp}/admin`);
    const r = await (await fetch(`http://127.0.0.1:${port}/feedback/lnaddress?a=${a}`, { headers: hdr })).json();
    await new Promise((ok) => setTimeout(ok, 300));
    console.log('  MEASURED:', JSON.stringify({ answer: r, connectionsToFaucetLoopback: connections }));
    assert.equal(connections, 0, `the faucet opened ${connections} connection(s) to 127.0.0.1:${lp} for a caller's address`);
  } finally { child.kill(); local.close(); }
});
