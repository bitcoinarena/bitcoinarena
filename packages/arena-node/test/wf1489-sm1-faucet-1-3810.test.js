// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-faucet-31 (state machine audit 2026-11-27, SM-19 faucet book, refill rows): a pending REFILL row still names the payers that were
// asked by their INDEX in FAUCET_PAYERS (#1926 moved the player rows to payerIds, the refill rows kept `payers: [i]`). After a restart with the payer
// list in another order the sweep asks a different lnd, which answers "not initiated": the refill row is dropped while the lnd that holds the payment
// still has it in flight. The row no longer counts toward REFILL_DAY_CAP_SATS, and the same invoice is accepted and paid again by the other lnd.
// Invariant: a pending refill row is decided only by the payers that really were asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const INVOICE = `lntb200u1p${'r'.repeat(40)}`;

test('sm1-faucet-31: a pending refill stays pending after a restart that reorders FAUCET_PAYERS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-f31-'));
  const fake = join(dir, 'lncli');
  writeFileSync(join(dir, 'token'), 't'.repeat(32));
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), inv = a[a.length - 1];
const me = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12);
const h = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '20000', payment_hash: h(inv), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + me })); process.exit(0); }
if (a.includes('payinvoice')) {
  fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, me + ' ' + h(inv).slice(0, 8) + '\\n');
  if (me === '127.0.0.1:2') { console.log('Payment status: SUCCEEDED, preimage: ' + 'ab'.repeat(32)); process.exit(0); }
  setTimeout(() => process.exit(1), 30000); return;   // the old lnd: the HTLC is on its way, payinvoice runs past the faucet's 15 s
}
if (a.includes('trackpayment')) {
  if (me === '127.0.0.1:2') { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  setTimeout(() => process.exit(1), 30000); return;   // in flight at the old lnd
}
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  const start = (payers) => {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
      FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_REFILL_TOKEN_FILE: join(dir, 'token'),
      FAUCET_PAYERS: payers.map((p) => `${dir}|${p}`).join(','), FAUCET_PAY_WAIT_MS: '600', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
    return { port, child };
  };
  const up = async (port) => { for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); return; } catch { await new Promise((ok) => setTimeout(ok, 100)); } } };
  const refill = async (port) => (await fetch(`http://127.0.0.1:${port}/refill`, { method: 'POST', body: JSON.stringify({ token: 't'.repeat(32), invoice: INVOICE }) })).json();
  // 1. one payer: payinvoice runs into the faucet's 15 s with the HTLC in flight - the refill is answered and booked pending, payers [0]
  let s = start(['127.0.0.1:1']);
  let first, rowsBefore;
  try { await up(s.port); first = await refill(s.port); rowsBefore = (book().refills || []).map((r) => ({ pending: !!r.pending, payers: r.payers })); }
  finally { s.child.kill(); }
  await new Promise((ok) => setTimeout(ok, 300));
  // 2. restarted with a second payer listed first: index 0 is now another lnd
  s = start(['127.0.0.1:2', '127.0.0.1:1']);
  let rowsAfter, again;
  try {
    await up(s.port);
    await new Promise((ok) => setTimeout(ok, 3000));   // sweep passes: index 0 is the new lnd, it answers at once
    rowsAfter = (book().refills || []).map((r) => ({ pending: !!r.pending, payers: r.payers }));
    again = await refill(s.port);
  } finally { s.child.kill(); }
  const pays = readFileSync(join(dir, 'pays.log'), 'utf8').trim().split('\n');
  console.log('  MEASURED sm1-faucet-31:', JSON.stringify({ first, rowsBefore, rowsAfter, again, pays }));
  assert.equal(first.ok, true);
  assert.deepEqual(rowsBefore, [{ pending: true, payers: [0] }]);
  assert.equal(rowsAfter.length, 1, 'the in-flight refill must stay on the book: the lnd that holds it was never asked');
  assert.notEqual(again.ok, true, 'the same invoice is not paid again while its first payment is in flight');
  assert.equal(pays.length, 1, 'one payinvoice for one refill invoice');
});
