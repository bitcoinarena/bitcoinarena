// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute 2 of #1537 (596b5fa19, #1714): POST /feedback now shares GET /feedback/lnaddress's one global minute (120 checks). A stranger
// (any Origin header, a few dozen /64s or IPv4s, each within its 30 per 10 minutes) keeps that minute full with addresses that are not even
// addresses - a slot is taken before the address is parsed, so nothing is fetched - and every honest reporter naming a bounty address is refused
// "try again in a minute", for as long as the stranger keeps it up. Before 596b5fa19 the GET door's traffic never refused a report.
// Safe: an honest report from another caller is not refused by other callers' typing checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ORIGIN = 'https://testnet.bitcoinarena.io', KEY = 'k'.repeat(64);
test('#1489 refute #1537: a stranger\'s GET checks lock every honest bounty report out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489v1r40s2-'));
  writeFileSync(join(dir, 'chat.token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_BOUNTY_ORIGINS: ORIGIN, FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: 'http://127.0.0.1:1', FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat.token'), FAUCET_CHAT_CHANNEL: 'c' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    // the stranger: 5 IPv4 addresses, 24 checks each (under the 30 per 10 minutes), of text that is no address at all
    let strangerAnswers = 0;
    for (let i = 1; i <= 5; i++) for (let j = 0; j < 24; j++) {
      const r = await (await fetch(`http://127.0.0.1:${port}/feedback/lnaddress?a=nothing`, { headers: { origin: ORIGIN, 'x-arena-ip': `198.51.100.${i}`, 'x-arena-worker': KEY } })).json();
      if (!/too many/.test(String(r.why))) strangerAnswers++;
    }
    // an honest reporter elsewhere, a first report naming a bounty address
    const r = await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '203.0.113.9', 'x-arena-worker': KEY },
      body: JSON.stringify({ text: 'the round froze after Join\nBounty address: honest@wallet.invalid' }) })).json();
    console.log('  MEASURED:', JSON.stringify({ strangerChecksAnswered: strangerAnswers, honest: r }));
    assert.doesNotMatch(String(r.why), /too many addresses are being checked/, 'an honest first report was refused because a stranger filled the shared minute with non-addresses');
  } finally { child.kill(); }
});
