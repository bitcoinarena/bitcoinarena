// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-faucet-1 (bypass of #3243 through the #3263 fix): once the all-callers count of wrong admin codes is full, a caller with no
// wrong code of its own is still let through (so the owner is never locked out) - but every fresh IPv6 /64 is such a caller. One /48 holds
// 65,536 /64s, so a stranger keeps guessing the admin code at one guess per fresh /64, without end. Safe: past the global limit, the network
// (IPv6 /48) that sent the wrong codes is refused too, while the owner from another network with no wrong code still gets in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'admin-code-r40';

test('r40-faucet-1 fresh /64s of one /48 cannot keep guessing the admin code past the global limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-r40-1-'));
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
    // 30 wrong codes, 5 from each of six /64s of 2001:db8:77::/48: the all-callers count is full
    let n = 0;
    for (let s = 1; s <= 6; s++) for (let i = 0; i < 5; i++) assert.equal(await list(`guess-${n++}`, `2001:db8:77:${s.toString(16)}::1`), 403);
    // then one wrong code from each of 60 fresh /64s of the same /48
    const said = [];
    for (let s = 0x100; s < 0x100 + 60; s++) said.push(await list(`guess-${n++}`, `2001:db8:77:${s.toString(16)}::1`));
    const checked = said.filter((x) => x === 403).length;
    console.log(`after the global limit: ${checked} of ${said.length} fresh-/64 guesses were checked (403), ${said.filter((x) => x === 429).length} refused (429)`);
    assert.ok(checked <= 5, `past the global limit the /48 kept guessing: ${checked} of 60 guesses from fresh /64s of one /48 were checked against the code`);
    // and the owner (another network, no wrong code of its own) is never locked out (#3263)
    assert.equal(await list(ADMIN, '198.51.100.7'), 200, 'the owner still gets in');
  } finally { faucet.kill(); }
});
