// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1381 (Daniel 2026-11-09: "Das Ziel ist unter 3s fuer die 500"): the welcome as a ready e-cash note from the faucet's pool
// (FAUCET_ECASH_POOL/<federation>/<msat>-*.json, filled by tools/faucet-ecash.mjs keep). The real tools/faucet.mjs; no Lightning is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '33'.repeat(32), OTHER = '44'.repeat(32);
const note = (dir, fed, msat, ecash) => { mkdirSync(join(dir, fed), { recursive: true }); writeFileSync(join(dir, fed, `${msat}-${Date.now()}-${ecash}.json`), JSON.stringify({ msat: String(msat), ecash, federation: fed })); };
async function faucet(fill, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'faucet1381e-')), pool = join(dir, 'pool');
  mkdirSync(pool);
  fill(pool);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_FEEDBACK_DB: join(dir, 'fb.db'),
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (body) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify(body) })).json();
    return await fn({ ask, pool, book: () => JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')) });
  } finally { child.kill(); }
}

test('#1381 a welcome that names its federation gets a ready note, once per account, and the note leaves the pool', async () => {
  await faucet((pool) => { note(pool, FED, 500000, 'fedimintaaa'); note(pool, FED, 500000, 'fedimintbbb'); }, async ({ ask, pool, book }) => {
    const first = await ask({ kind: 'welcome', account: 'cd'.repeat(32), ecash: FED });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.sats, 500);
    assert.match(first.ecash, /^fedimint(aaa|bbb)$/);
    assert.equal(readdirSync(join(pool, FED)).filter((f) => f.endsWith('.json')).length, 1, 'the note handed out is still in the pool');
    assert.equal(existsSync(join(pool, FED, 'taken')), true);
    const again = await ask({ kind: 'welcome', account: 'cd'.repeat(32), ecash: FED });
    assert.equal(again.ok, false);
    assert.match(again.why, /already has/);
    const other = await ask({ kind: 'welcome', account: 'ef'.repeat(32), ecash: FED });
    assert.equal(other.ok, true);
    assert.notEqual(other.ecash, first.ecash, 'one note handed out twice');
    const rows = book().players;
    assert.equal(rows.length, 2);
    assert.equal(rows.every((r) => r.ecash === true && r.sats === 500 && r.kind === 'welcome'), true);
  });
});

test('#1381 no note of that federation or amount: nothing given, nothing booked - the page asks with an invoice', async () => {
  await faucet((pool) => { note(pool, OTHER, 500000, 'fedimintccc'); note(pool, FED, 300000, 'fedimintddd'); }, async ({ ask, book }) => {
    const r = await ask({ kind: 'welcome', account: 'cd'.repeat(32), ecash: FED });
    assert.deepEqual(r, { ok: false, noEcash: true, why: 'no e-cash is ready: ask with an invoice' });
    let rows = []; try { rows = book().players || []; } catch { rows = []; }
    assert.equal(rows.length, 0);
    const bad = await ask({ kind: 'welcome', account: 'cd'.repeat(32), ecash: 'not-a-federation' });
    assert.equal(bad.noEcash, true);
  });
});

test('#1381 a top-up is never paid from the pool', async () => {
  await faucet((pool) => { note(pool, FED, 500000, 'fedimintaaa'); note(pool, FED, 300000, 'fedimintbbb'); }, async ({ ask, pool }) => {
    const r = await ask({ kind: 'topup', account: 'cd'.repeat(32), ecash: FED });
    assert.equal(r.ok, false);
    assert.equal(r.ecash, undefined);
    assert.equal(readdirSync(join(pool, FED)).filter((f) => f.endsWith('.json')).length, 2);
  });
});

test('#1381 the day caps hold for e-cash too: the eleventh welcome from one address gets nothing', async () => {
  await faucet((pool) => { for (let i = 0; i < 12; i++) note(pool, FED, 500000, `fedimint${i}x`); }, async ({ ask }) => {
    const got = [];
    for (let i = 0; i < 11; i++) got.push(await ask({ kind: 'welcome', account: (i + 16).toString(16).padStart(2, '0').repeat(32), ecash: FED }));
    assert.equal(got.slice(0, 10).every((r) => r.ok), true);
    assert.equal(got[10].ok, false);
    assert.match(got[10].why, /address took all/);
  });
});
