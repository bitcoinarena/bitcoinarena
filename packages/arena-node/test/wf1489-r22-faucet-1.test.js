// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 22 (faucet): A STRANGER LOCKS THE OWNER OUT OF THE REVIEW AND PAYOUT DOORS (side effect of the #3243 fix). The admin door counts
// wrong codes per caller (5) and for all callers together (ADMIN_TRIES_ALL = 30 in 15 min), and past the global count it answers 429 to everyone,
// the right code included. Six addresses (or one IPv6 /64: the caller is the raw address) sending 5 junk codes each every 15 minutes - one request
// every 30 s - keep /feedback/admin/* closed for good: no approve, no reward link, no address payout, so every bounty payout stalls.
// Safe: wrong codes from other addresses never refuse the right code from an address that sent none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'admin-code-r22';

test('#1489-r22 strangers\' wrong admin codes do not lock the owner out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r22f1-'));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
    FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_WORKER_KEY: '' };
  const base = `http://127.0.0.1:${port}`;
  const list = (code, ip) => fetch(`${base}/feedback/admin/list?lite=1`, { headers: { 'x-arena-admin': code, 'x-forwarded-for': ip } }).then((r) => r.status);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'inherit'], env });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal(await list(ADMIN, '198.51.100.7'), 200, 'the owner gets in before');
    const seen = [];
    for (let a = 0; a < 6; a++) for (let i = 0; i < 5; i++) seen.push(await list(`junk-${a}-${i}`, `2001:db8:1:2::${a + 1}`));
    const owner = await list(ADMIN, '198.51.100.7');
    console.log('  MEASURED:', JSON.stringify({ strangerRequests: seen.length, strangerStatuses: [...new Set(seen)], ownerWithRightCode: owner }));
    assert.equal(owner, 200, 'the owner, from an address that sent no wrong code, still opens the review list with the right code');
  } finally { faucet.kill(); }
});
