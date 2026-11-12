// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (faucet): THE SCREENSHOT LIMITS ARE CHECKED BEFORE THE BODY IS READ AND COUNTED ONLY AFTER IT IS WRITTEN. POST /feedback/screenshot
// tests SHOTS_PER_IP_PER_DAY (10) and SHOT_DAY_BYTES when the request arrives, but pushes the upload into SHOT_UPLOADS only at its end. One caller that opens
// many uploads at once passes both checks with every one of them, and each distinct image is written to disk: the per-address count and the day's byte
// cap of #1405 do not hold. Safe: one address stores at most 10 screenshots a day, and the day's bytes stay within the cap, however the uploads overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

test('#1489-r5 overlapping screenshot uploads from one address do not pass the per-address count or the day\'s byte cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r5f1-'));
  const shots = join(dir, 'shots');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const DAY_BYTES = 3_000_000;
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_FEEDBACK_SHOTS: shots,
    FAUCET_SHOT_DAY_BYTES: String(DAY_BYTES), FAUCET_SHOT_FREE_FLOOR_BYTES: '0' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const N = 30, SIZE = 500_000;
    // every upload opened and its first bytes sent before any one ends
    const open = Array.from({ length: N }, () => {
      const req = request({ host: '127.0.0.1', port, path: '/feedback/screenshot', method: 'POST', headers: { 'content-type': 'image/png', 'x-arena-ip': '203.0.113.9', 'x-arena-worker': KEY } });
      const answer = new Promise((ok) => { req.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, body: b })); }); req.on('error', (e) => ok({ status: 0, body: e.message })); });
      req.write(Buffer.concat([PNG, randomBytes(1000)]));
      return { req, answer };
    });
    await sleep(800);
    for (const o of open) o.req.end(randomBytes(SIZE));
    const answers = await Promise.all(open.map((o) => o.answer));
    const stored = answers.filter((a) => a.status === 200).length;
    const files = readdirSync(shots).filter((f) => /\.(png|jpg|webp)$/.test(f));
    const bytes = files.reduce((n, f) => n + statSync(join(shots, f)).size, 0);
    console.log('  MEASURED:', JSON.stringify({ uploads: N, stored, files: files.length, bytes, dayCap: DAY_BYTES, statuses: [...new Set(answers.map((a) => a.status))] }));
    assert.ok(stored <= 10, `one address stores at most 10 screenshots a day (stored ${stored})`);
    assert.ok(bytes <= DAY_BYTES + SIZE + 2000, `the day's bytes stay within the cap (${bytes} written, cap ${DAY_BYTES})`);
  } finally { child.kill(); }
});
