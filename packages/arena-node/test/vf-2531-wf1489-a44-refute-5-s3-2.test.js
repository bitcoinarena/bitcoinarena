// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-5 skeptic 3 (re-check of #1628/#1834/#2132): unsureWelcome and playerGrantDecide compare `u.account === account`, but the
// account is only checked as String(account) against /^[0-9a-f]{64}$/. A JSON body with account ["<the account>"] passes the format check and matches
// no unsure row and no booked row: the account whose welcome is still unsure is paid a second one (stored under an array, never matched later either).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');

// a fake lncli: inv2 pays at once (logged), every other invoice finds no route; every earlier payment is still IN_FLIGHT (held)
async function faucetWith(unsure, inv2) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-5-s3-'));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), last = a[a.length - 1];
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: require('crypto').createHash('sha256').update(last).digest('hex'), destination: 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k1' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (last === ${JSON.stringify(inv2)}) { fs.appendFileSync(${JSON.stringify(join(dir, 'paid.log'))}, last + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }
  console.error('[lncli] rpc error: unable to find a path'); process.exit(1);
}
if (a.includes('trackpayment')) { console.log('Payment status: IN_FLIGHT'); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [], unsure }));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_WORKER_KEY: '',
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_PAY_WAIT_MS: '600', FAUCET_PAY_SETTLE_MS: '600', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  const ask = (body, ip) => fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) }).then((r) => r.json());
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
  const paidCount = () => existsSync(join(dir, 'paid.log')) ? readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').length : 0;
  const book = () => JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
  return { ask, paidCount, book, stop: () => child.kill('SIGKILL') };
}

test('#1489 a44-refute-5-s3-2: account ["<hex>"] (an array) is paid a second welcome while the account\'s first is unsure', async () => {
  const now = Date.now(), target = 'cd'.repeat(32), inv1 = `lntb30u1p${'q'.repeat(40)}`, inv2 = `lntb30u1p${'z'.repeat(40)}`;
  const unsure = [{ account: target, kind: 'welcome', ip: '198.51.100.9', sats: 3000, atMs: now - 7200000, hash: sha(inv1), payers: [0], removedMs: now - 7200000 }];
  const f = await faucetWith(unsure, inv2);
  try {
    const plain = await f.ask({ kind: 'welcome', account: target, invoice: inv2 }, '198.51.100.10');
    const arr = await f.ask({ kind: 'welcome', account: [target], invoice: inv2 }, '198.51.100.10');
    await sleep(300);
    console.log('  MEASURED a44-refute-5-s3-2:', JSON.stringify({ plain, arr, secondWelcomesPaid: f.paidCount(), rows: (f.book().players || []).map((r) => ({ account: r.account, kind: r.kind })) }));
    assert.equal(plain.ok, false, 'the #1628/#1834 fix refuses a plain second welcome');
    assert.equal(arr.ok, false, 'account [hex] was paid a second welcome while the first is still in flight');
    assert.equal(f.paidCount(), 0, 'a second 3000-sat welcome went out');
  } finally { f.stop(); }
});
