// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 state-machine audit round 8 (faucet): readBook() answers { paid: [] } for ANY error reading FAUCET_BOOK - not only "no book yet".
// One read that fails for a moment (EMFILE under load, EIO, a permission slip; here the file is made unreadable for one request) makes the faucet decide
// on an empty book: an account that already has its welcome is paid a second one, and saveBook() then writes that empty book plus the one new row over
// the real one - every address, welcome, top-up, refill and unsure row ever booked is gone, and every limit starts from zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');

test('#1489 sm8-faucet-2: a book that cannot be read for a moment is not taken as empty (no second welcome, the book is not overwritten)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm8-faucet-2-'));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: require('crypto').createHash('sha256').update(a[a.length - 1]).digest('hex'), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k1' })); process.exit(0); }
if (a.includes('payinvoice')) { require('fs').appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, a[a.length - 1] + '\\n'); console.log('Payment status: SUCCEEDED, preimage: ' + 'cd'.repeat(32)); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const BOOK = join(dir, 'book.json');
  const ACCOUNT = 'cd'.repeat(32);
  // the book as it stands: this account's welcome, an installer's address, other players
  const held = { paid: [{ address: 'tb1q' + 'q'.repeat(38), ip: '203.0.113.1', sats: 100000, atMs: Date.now() - 3600000, txid: 'ee'.repeat(32) }],
    players: [{ account: ACCOUNT, kind: 'welcome', ip: '198.51.100.9', sats: 3000, atMs: Date.now() - 600000, hash: 'aa'.repeat(32) },
      ...Array.from({ length: 5 }, (_, i) => ({ account: String(i).repeat(64).slice(0, 64).replace(/[^0-9]/g, '1'), kind: 'welcome', ip: '198.51.100.20', sats: 3000, atMs: Date.now() - 500000, hash: String(i + 1).repeat(64) }))] };
  writeFileSync(BOOK, JSON.stringify(held));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: BOOK, FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_SWEEP_MS: '600000' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (inv) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ kind: 'welcome', account: ACCOUNT, invoice: inv }) })).json();
    const before = await ask(`lntb30u1p${'a'.repeat(40)}`);   // the book reads: refused, as it must be
    chmodSync(BOOK, 0o000);                                    // one read fails (here: no permission for a moment)
    const during = await ask(`lntb30u1p${'b'.repeat(40)}`);
    chmodSync(BOOK, 0o644);
    const after = JSON.parse(readFileSync(BOOK, 'utf8'));
    const welcomes = (after.players || []).filter((p) => p.account === ACCOUNT && p.kind === 'welcome').length;
    console.log('  MEASURED sm8-faucet-2:', JSON.stringify({ before, during, paid: (() => { try { return readFileSync(join(dir, 'pays.log'), 'utf8').trim().split('\n').length; } catch { return 0; } })(),
      bookBefore: { paid: held.paid.length, players: held.players.length }, bookAfter: { paid: (after.paid || []).length, players: (after.players || []).length }, welcomesOfAccount: welcomes }));
    assert.equal(before.ok, false);
    assert.equal(during.ok, false, `a second welcome was paid to an account that has one, on a book that could not be read: ${JSON.stringify(during)}`);
    assert.equal((after.players || []).length, held.players.length, 'the booked players\' rows were overwritten by an empty book');
    assert.equal((after.paid || []).length, held.paid.length, 'the installer\'s paid addresses were overwritten by an empty book');
  } finally { try { chmodSync(BOOK, 0o644); } catch { /* */ } child.kill(); }
});
