// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-5 (re-check of #1628, SM-19): an unsure welcome blocks the account's next welcome only while its row is IN `unsure` - and
// grantPay keeps that list at its newest 500 (.slice(-500)). An attacker whose own welcome sits unsure (payment still IN_FLIGHT: an HTLC its node
// accepted late and holds) floods `unsure` with other accounts' welcomes whose payments also stay in flight (3 addresses take 600 a day): the 501st
// pushes the held welcome out. The account then asks again with a new invoice and is paid at once; when the held one settles nobody books it.
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

test('#1489 a44-refute-5-1: flooding `unsure` past 500 rows frees an account whose welcome is still in flight for a second welcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-5-'));
  const inv1 = `lntb30u1p${'q'.repeat(40)}`, inv2 = `lntb30u1p${'z'.repeat(40)}`, invFlood = `lntb30u1p${'f'.repeat(40)}`;
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
  const now = Date.now(), target = 'cd'.repeat(32);
  // the attacker's own welcome, unsure (its payment held IN_FLIGHT), then 499 more unsure welcomes of other accounts from 3 addresses (200 a day each)
  const unsure = [{ account: target, kind: 'welcome', ip: '198.51.100.9', sats: 3000, atMs: now - 7200000, hash: sha(inv1), payers: [0], removedMs: now - 7200000 }];
  for (let i = 0; i < 499; i++) unsure.push({ account: i.toString(16).padStart(64, '0'), kind: 'welcome', ip: `203.0.113.${1 + (i % 3)}`, sats: 3000, atMs: now - 7200000, hash: sha(`flood${i}`), payers: [0], removedMs: now - 7200000 });
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [], players: [], unsure }));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_PAY_WAIT_MS: '600', FAUCET_PAY_SETTLE_MS: '600', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  const ask = (account, invoice, ip) => fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': ip },
    body: JSON.stringify({ kind: 'welcome', account, invoice }) }).then((r) => r.json());
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const before = await ask(target, inv2, '198.51.100.10');   // the fix: refused while the first is unsure
    const flood = await ask('ee'.repeat(32), invFlood, '203.0.113.50');   // the 501st unsure row
    const book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
    const targetStillUnsure = (book.unsure || []).some((u) => u.account === target);
    const second = await ask(target, inv2, '198.51.100.10');
    await sleep(800);
    const paid = existsSync(join(dir, 'paid.log')) ? readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').length : 0;
    console.log('  MEASURED a44-refute-5-1:', JSON.stringify({ before, flood, unsureRows: (book.unsure || []).length, targetStillUnsure, second, secondWelcomesPaid: paid }));
    assert.equal(before.ok, false, 'the fix refuses a welcome while the first is unsure');
    assert.ok(targetStillUnsure, 'the held welcome was pushed out of `unsure` by other accounts\' rows');
    assert.equal(second.ok, false, 'a second welcome was paid while the first is still in flight');
  } finally { child.kill('SIGKILL'); }
});
