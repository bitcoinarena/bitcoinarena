// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 22 (faucet): THE SCREENSHOT DAY IS CLOSED FROM ONE IPv6 /48. POST /feedback/screenshot counts an address by its /64 (10 a day) and
// all callers together against SHOT_DAY_BYTES, with no bound on an enclosing network - the class the reports (#1679, #2158), the node faucet (#2539)
// and the players' faucet (#2757) each closed. A home /56 (256 /64s) or any /48 fills the day's bytes in 20+ uploads, and every honest reporter's
// screenshot is refused 429 until UTC midnight. Safe: one /48 holds at most a share of the day, so an upload from another network still goes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

test('#1489-r22 one IPv6 /48 does not use up the day\'s screenshot bytes for everyone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r22f2-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const DAY_BYTES = 3_000_000, SIZE = 100_000;
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_FEEDBACK_SHOTS: join(dir, 'shots'),
    FAUCET_SHOT_DAY_BYTES: String(DAY_BYTES), FAUCET_SHOT_FREE_FLOOR_BYTES: '0' }, stdio: 'ignore' });
  const up = async (ip) => { const r = await fetch(`http://127.0.0.1:${port}/feedback/screenshot`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-arena-ip': ip, 'x-arena-worker': KEY }, body: Buffer.concat([PNG, randomBytes(SIZE)]) }); return r.status; };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    let stored = 0;
    for (let n = 0; n < 40; n++) if (await up(`2001:db8:77:${(n >> 3).toString(16)}::${(n & 7) + 1}`) === 200) stored++;   // 5 /64s of 2001:db8:77::/48, 8 each
    const honest = await up('198.51.100.20');
    console.log('  MEASURED:', JSON.stringify({ oneSlash48Stored: stored, bytes: stored * (SIZE + PNG.length), dayCap: DAY_BYTES, honestStatus: honest }));
    assert.equal(honest, 200, 'a reporter on another network can still add a screenshot');
  } finally { child.kill(); }
});
