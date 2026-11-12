// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 state-machine audit round 8 (faucet): lncli payinvoice (table output, lnd cmd/commands/cmd_payments.go PrintLivePayment: "Always print
// in-flight updates for the table output") prints EVERY update of the payment - with stdout not a terminal the "clear lines" codes do not erase them -
// so a payment that FAILED within the wait prints "Payment status: IN_FLIGHT" first and "Payment status: FAILED, reason: ..." last, and exits 1.
// grant() (and /refill) take any "Payment status: IN_FLIGHT" line as sent: a welcome whose payment had already FAILED is answered ok, booked pending,
// the next payer is never asked, and the sweep then removes the row - the page was told 3,000 sat that never came.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ab'.repeat(32);

function fakeLncli(dir) {
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
const rpc = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12);
const sats = fs.existsSync(${JSON.stringify(join(dir, 'sats'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'sats'))}, 'utf8').trim() : '3000';
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: sats, payment_hash: '${HASH}', destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + rpc })); process.exit(0); }
const table = (st) => '+-----------+\\n| HTLC_STATE |\\n+-----------+\\nAmount + fee:   0 + 0 sat\\nPayment hash:   ${HASH}\\nPayment status: ' + st;
if (a.includes('payinvoice')) {
  fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, rpc + '\\n');
  // payer A: no route - the in-flight update, then the final FAILED one (lncli exits 1, "[lncli] FAILED")
  if (rpc === '127.0.0.1:1') { process.stdout.write(table('IN_FLIGHT') + '\\n\\x1b[1A\\x1b[2K' + table('FAILED, reason: FAILURE_REASON_NO_ROUTE') + '\\n'); console.error('[lncli] FAILED'); process.exit(1); }
  process.stdout.write(table('IN_FLIGHT') + '\\n' + table('SUCCEEDED, preimage: ' + 'cd'.repeat(32)) + '\\n'); process.exit(0);
}
if (a.includes('trackpayment')) { console.log(table(rpc === '127.0.0.1:1' ? 'FAILED, reason: FAILURE_REASON_NO_ROUTE' : 'SUCCEEDED, preimage: ' + 'cd'.repeat(32))); process.exit(0); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [{ payment_hash: '${HASH}', status: rpc === '127.0.0.1:1' ? 'FAILED' : 'SUCCEEDED', htlcs: [] }] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  return fake;
}

async function faucet(dir) {
  const port = 20000 + Math.floor(Math.random() * 10000);
  writeFileSync(join(dir, 'token'), 'refill-token');
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fakeLncli(dir), FAUCET_REFILL_TOKEN_FILE: join(dir, 'token'),
    FAUCET_PAYERS: `${dir}|127.0.0.1:1,${dir}|127.0.0.1:2`, FAUCET_PAY_WAIT_MS: '5000', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
  return { port, child };
}
const book = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
const pays = (dir) => { try { return readFileSync(join(dir, 'pays.log'), 'utf8').trim().split('\n'); } catch { return []; } };

test('#1489 sm8-faucet-1: a welcome whose payment FAILED (lncli printed its in-flight update first) is not answered paid; the next payer pays it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm8-faucet-1-'));
  const { port, child } = await faucet(dir);
  try {
    const r = await (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ kind: 'welcome', account: 'cd'.repeat(32), invoice: `lntb30u1p${'q'.repeat(40)}` }) })).json();
    const asked = pays(dir), right = (book(dir).players || []).map((x) => (x.pending ? 'pending' : 'booked'));
    await new Promise((ok) => setTimeout(ok, 1500));   // a few sweeps
    const later = (book(dir).players || []).map((x) => (x.pending ? 'pending' : 'booked'));
    console.log('  MEASURED sm8-faucet-1 welcome:', JSON.stringify({ answer: r, payersAsked: asked, rowAtAnswer: right, rowAfterSweep: later }));
    // the welcome the page was told it got is a payment that went: payer B (the second) was asked after A's FAILED, and the row stays booked
    assert.ok(!r.ok || asked.includes('127.0.0.1:2'), `answered ok (${JSON.stringify(r)}) while only payer A was asked, and A's payment had FAILED`);
    assert.ok(!r.ok || later.length === 1, `answered ok, yet the sweep took the welcome off the book (nothing was paid): ${JSON.stringify(later)}`);
  } finally { child.kill(); }
});

test('#1489 sm8-faucet-1: a refill whose payment FAILED (in-flight update printed first) is not answered ok; the next payer pays it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm8-faucet-1r-'));
  writeFileSync(join(dir, 'sats'), '5000');
  const { port, child } = await faucet(dir);
  try {
    const r = await (await fetch(`http://127.0.0.1:${port}/refill`, { method: 'POST', body: JSON.stringify({ token: 'refill-token', invoice: `lntb50u1p${'q'.repeat(40)}` }) })).json();
    const asked = pays(dir);
    console.log('  MEASURED sm8-faucet-1 refill:', JSON.stringify({ answer: r, payersAsked: asked, refills: book(dir).refills || [] }));
    assert.ok(!r.ok || asked.includes('127.0.0.1:2'), `refill answered ok (${JSON.stringify(r)}) while only payer A was asked, and A's payment had FAILED`);
  } finally { child.kill(); }
});
