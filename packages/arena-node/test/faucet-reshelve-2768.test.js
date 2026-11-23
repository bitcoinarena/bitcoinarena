// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2768 (feedback #061: a new wallet shows 3,000 sat, then 0 six seconds later): the faucet's start scan (#1835) put back on the shelf every
// note in taken/ that no book row named - also notes handed out days before under rows the book no longer held (72 welcomes of 11-09/11-10 are in
// the faucet's log and not in its book; 170 notes went back on 11-12). Each was handed out again, and the new wallet's reissue was Rejected (the
// notes were spent): the header showed the pending 3,000 sat, then 0. Now a take stamps the note's file with the take's time, and the scan puts
// back only a note taken minutes before the start (a faucet killed between the take and the book write); an older one stays in taken/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '33'.repeat(32);

test('kanban #2768: the start scan puts back a note taken minutes ago, never one handed out days ago that the book lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-2768-')), pool = join(dir, 'pool'), taken = join(pool, FED, 'taken');
  mkdirSync(taken, { recursive: true });
  const note = (n) => JSON.stringify({ msat: '3000000', ecash: `fedimint${n}`, federation: FED });
  writeFileSync(join(taken, '3000000-1-old.json'), note('old'));
  const days = new Date(Date.now() - 3 * 86400000); utimesSync(join(taken, '3000000-1-old.json'), days, days);   // taken three days ago
  writeFileSync(join(taken, '3000000-2-stranded.json'), note('stranded'));                                      // taken just now
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [] }));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    assert.deepEqual(readdirSync(taken).sort(), ['3000000-1-old.json'], 'the note handed out days ago stays taken');
    assert.equal(existsSync(join(pool, FED, '3000000-2-stranded.json')), true, 'the note of a take just before the start is back on the shelf');
  } finally { child.kill(); }
});

test('kanban #2768: a take stamps the note with its own time, so a restart soon after finds it recent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-2768b-')), pool = join(dir, 'pool');
  mkdirSync(join(pool, FED), { recursive: true });
  const f = join(pool, FED, '3000000-1-minted.json');
  writeFileSync(f, JSON.stringify({ msat: '3000000', ecash: 'fedimintminted', federation: FED }));
  const minted = new Date(Date.now() - 5 * 86400000); utimesSync(f, minted, minted);   // minted five days ago
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const r = await (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' }, body: JSON.stringify({ kind: 'welcome', account: 'ef'.repeat(32), ecash: FED }) })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    const { statSync } = await import('node:fs');
    const t = statSync(join(pool, FED, 'taken', '3000000-1-minted.json')).mtimeMs;
    assert.ok(Date.now() - t < 60000, 'the taken note carries the take\'s time, not its mint time');
  } finally { child.kill(); }
});
