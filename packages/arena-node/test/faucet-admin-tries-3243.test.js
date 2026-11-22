// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3243 (audit r10): wrong admin codes are counted - 5 a caller in 15 min, then 429 for that caller, the right code included; another
// caller is not locked by them; the right code before the limit works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'admin-code-3243';

test('#3243 the admin API locks a caller out after 5 wrong codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-admin-3243-'));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
    FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_WORKER_KEY: '' };
  const base = `http://127.0.0.1:${port}`;
  const list = (code, ip) => fetch(`${base}/feedback/admin/list?lite=1`, { headers: { 'x-arena-admin': code, 'x-forwarded-for': ip } }).then((r) => r.status);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore', env });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal(await list(ADMIN, '198.51.100.7'), 200, 'the right code works');
    for (let i = 0; i < 5; i++) assert.equal(await list('guess-' + i, '203.0.113.9'), 403);
    assert.equal(await list('guess-6', '203.0.113.9'), 429, 'the sixth wrong code is refused without a check');
    assert.equal(await list(ADMIN, '203.0.113.9'), 429, 'the locked caller learns nothing, even with the right code');
    assert.equal(await list(ADMIN, '198.51.100.7'), 200, 'another caller still gets in');
  } finally { faucet.kill(); }
});
