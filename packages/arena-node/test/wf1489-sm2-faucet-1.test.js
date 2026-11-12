// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-faucet-1 (state machine SM-19, the faucet book): grant() books the welcome row BEFORE paying, without `pending`, and only marks it
// pending after payinvoice answered. A faucet killed while payinvoice runs (a restart, a crash, a deploy) leaves a plain booked row: the sweep reads
// only pending rows and the `unsure` list, so the row is never checked against the payer. Here the payer never paid (trackpayment: not initiated),
// yet the account's welcome is refused forever ("already has its welcome sats") - a record that says paid for a payment that never happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('#1489 sm2-faucet-1: a welcome whose faucet died mid-payinvoice is not booked as paid forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-1-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'hang' }));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'spec.json'))}, 'utf8'));
const inv = a[a.length - 1];
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: require('crypto').createHash('sha256').update(inv).digest('hex'), destination: 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k1' })); process.exit(0); }
if (a.includes('payinvoice')) {
  fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, inv + '\\n');
  if (spec.pay === 'ok') { fs.appendFileSync(${JSON.stringify(join(dir, 'paid.log'))}, inv + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }
  // the faucet is killed while this runs: the payment is never sent (this process dies with nothing done)
  setTimeout(() => process.exit(1), 20000); return;
}
if (a.includes('trackpayment')) { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_PAY_WAIT_MS: '8000', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' };
  const start = async () => {
    const c = spawn(process.execPath, [FAUCET], { env, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    return c;
  };
  const account = 'cd'.repeat(32);
  const ask = (invoice) => fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
    body: JSON.stringify({ kind: 'welcome', account, invoice }) }).then((r) => r.json(), (e) => ({ ok: false, why: `no answer: ${e.message}` }));
  let child = await start();
  try {
    const first = ask(`lntb30u1p${'q'.repeat(40)}`);
    // the faucet is inside payinvoice: killed there (SIGKILL, a crash)
    for (let i = 0; i < 100 && !existsSync(join(dir, 'pays.log')); i++) await sleep(50);
    assert.ok(existsSync(join(dir, 'pays.log')), 'payinvoice was asked');
    child.kill('SIGKILL');
    await first;
    const afterCrash = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')).players || [];
    // restarted; the payer pays now; the sweep runs several times
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'ok' }));
    child = await start();
    await sleep(1500);
    const again = await ask(`lntb30u1p${'z'.repeat(40)}`);
    const paid = existsSync(join(dir, 'paid.log')) ? readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const rows = (JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')).players || []).map((x) => ({ kind: x.kind, pending: !!x.pending }));
    console.log('  MEASURED sm2-faucet-1:', JSON.stringify({ afterCrash: afterCrash.map((x) => ({ kind: x.kind, pending: !!x.pending })), again, paymentsMade: paid, rows }));
    // the invariant: a welcome row stands only for a payment that happened or may still happen; the payer says it never started, so the account
    // gets its welcome (exactly one payment made in all)
    assert.equal(again.ok, true, `the account's welcome is refused although no payment was ever made: ${again.why}`);
    assert.equal(paid, 1);
  } finally { child.kill('SIGKILL'); }
});
