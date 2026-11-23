// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute #1835 (1): the start scan puts back a note a welcome DID hand out, when its book row is the #1381 shape (11-09..11-10,
// before #1419 added noteFile): { ecash: true, hash } and no noteFile. The note goes back on the shelf and is handed out to the next player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '33'.repeat(32);

test('#1489 a44-refute-85-1: a note handed out under a pre-#1419 row (no noteFile) stays in taken/ at start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-85-1-')), pool = join(dir, 'pool'), taken = join(pool, FED, 'taken');
  mkdirSync(taken, { recursive: true });
  const ecash = 'fedimintgivenon1109';
  writeFileSync(join(taken, '3000000-1-given.json'), JSON.stringify({ msat: '3000000', ecash, federation: FED }));
  const hash = createHash('sha256').update(ecash).digest('hex');
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [{ account: 'ab'.repeat(32), kind: 'welcome', ip: '198.51.100.9', sats: 3000, atMs: Date.parse('2026-11-09T12:00:00Z'), hash, ecash: true }] }));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const r = await (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.5' }, body: JSON.stringify({ kind: 'welcome', account: 'ef'.repeat(32), ecash: FED }) })).json();
    const facts = { taken: readdirSync(taken), shelf: readdirSync(join(pool, FED)).filter((f) => f.endsWith('.json')), secondPlayerGot: r.ecash || r.why || null };
    console.log('  FACTS a44-refute-85-1:', JSON.stringify(facts));
    assert.notEqual(r.ecash, ecash, 'the note the first player was given was handed out again to a second player');
    assert.deepEqual(facts.taken, ['3000000-1-given.json']);
  } finally { child.kill(); }
});
