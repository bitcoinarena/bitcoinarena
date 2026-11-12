// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm3-faucet-2 (state machine audit, the e-cash pool, SM-19): grantEcash takes a note off the shelf by renaming it into taken/ and only
// then writes the book. When the book cannot be written (a full disk, ENOSPC; here: its folder is not there), the welcome answers 500, the account
// is not booked - and the note stays in taken/, where nothing ever hands it out or puts it back. Each retry of the page takes the next note.
// Invariant: a note leaves the shelf only for a welcome the book holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '33'.repeat(32);

test('#1489 sm3-faucet-2: a welcome whose book write fails leaves its e-cash note on the shelf', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm3-faucet-2-')), pool = join(dir, 'pool');
  mkdirSync(join(pool, FED), { recursive: true });
  for (const n of ['aaa', 'bbb', 'ccc']) writeFileSync(join(pool, FED, `3000000-${Date.now()}-${n}.json`), JSON.stringify({ msat: '3000000', ecash: `fedimint${n}`, federation: FED }));
  const port = 20000 + Math.floor(Math.random() * 9000);
  // the book's folder is not there: every saveBook throws, as on a full disk
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'gone', 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(await (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ kind: 'welcome', account: 'cd'.repeat(32), ecash: FED }) })).json());
    const shelf = readdirSync(join(pool, FED)).filter((f) => f.endsWith('.json')).length;
    const taken = existsSync(join(pool, FED, 'taken')) ? readdirSync(join(pool, FED, 'taken')).length : 0;
    const facts = { answers: answers.map((a) => (a.ok ? 'paid' : a.why)), notesOnShelf: shelf, notesInTaken: taken, booked: existsSync(join(dir, 'gone', 'book.json')) };
    console.log('  FACTS sm3-faucet-2:', JSON.stringify(facts));
    assert.equal(answers.every((a) => a.ok !== true), true, 'no welcome was answered');
    assert.equal(facts.booked, false);
    assert.equal(shelf, 3, `${taken} notes left the shelf for welcomes nobody got and the book does not hold`);
  } finally { child.kill(); }
});

// kanban #1835: a faucet killed between the take and the book write - at start a note in taken/ no book row names goes back; a booked one stays
test('#1835: the start scan puts an unbooked taken/ note back on the shelf and leaves a booked one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm3-faucet-2b-')), pool = join(dir, 'pool'), taken = join(pool, FED, 'taken');
  mkdirSync(taken, { recursive: true });
  const note = (n) => JSON.stringify({ msat: '3000000', ecash: `fedimint${n}`, federation: FED });
  writeFileSync(join(taken, '3000000-1-booked.json'), note('booked')); writeFileSync(join(taken, '3000000-2-stranded.json'), note('stranded'));
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [{ account: 'ab'.repeat(32), kind: 'welcome', ecash: true, noteFile: join(taken, '3000000-1-booked.json') }] }));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    assert.deepEqual(readdirSync(taken).sort(), ['3000000-1-booked.json']);
    assert.equal(existsSync(join(pool, FED, '3000000-2-stranded.json')), true);
  } finally { child.kill(); }
});
