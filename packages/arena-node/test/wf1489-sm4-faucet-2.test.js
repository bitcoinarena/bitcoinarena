// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4-faucet-2 (state machine, SM-19 faucet book across a restart): a pending welcome row names the payers that were asked by their
// INDEX in FAUCET_PAYERS. When the faucet restarts with a payer list in another order (a payer added in front), the sweep asks a different lnd for
// the payment, which answers "not initiated" (NONE): the row is removed although the payer that holds the payment still has it in flight. The
// account asks again, is paid a second welcome, and the first payment then settles too. Invariant: a pending row is decided only by the payers
// that really were asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ACCOUNT = 'cd'.repeat(32);

test('sm4-faucet-2: a pending welcome stays pending after a restart that reorders FAUCET_PAYERS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm4-f2-'));
  const fake = join(dir, 'lncli');
  // two lnds: "old" holds the first payment in flight (an HTLC on its way); "new" has never seen it and pays at once whatever it is asked
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), inv = a[a.length - 1];
const me = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12);
const h = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: h(inv), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + me })); process.exit(0); }
if (a.includes('payinvoice')) {
  fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, me + ' ' + h(inv).slice(0, 8) + '\\n');
  if (me === '127.0.0.1:2') { console.log('Payment status: SUCCEEDED, preimage: ' + 'ab'.repeat(32)); process.exit(0); }
  setTimeout(() => process.exit(1), 30000); return;
}
if (a.includes('trackpayment')) {
  if (me === '127.0.0.1:2') { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  setTimeout(() => process.exit(1), 30000); return;   // in flight: trackpayment streams and never ends in time
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: me === '127.0.0.1:1' ? [{ payment_hash: h(${JSON.stringify(`lntb30u1p${'q'.repeat(40)}`)}), status: 'IN_FLIGHT', htlcs: [{ status: 'IN_FLIGHT' }] }] : [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  const start = (payers) => {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
      FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
      FAUCET_PAYERS: payers.map((p) => `${dir}|${p}`).join(','), FAUCET_PAY_WAIT_MS: '600', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
    return { port, child };
  };
  const up = async (port) => { for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); return; } catch { await new Promise((ok) => setTimeout(ok, 100)); } } };
  const ask = async (port, invoice) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
    body: JSON.stringify({ kind: 'welcome', account: ACCOUNT, invoice }) })).json();
  // 1. one payer: its payinvoice times out with the HTLC in flight - the welcome is booked pending, payer 0
  let s = start(['127.0.0.1:1']);
  let first, rowsBefore;
  try { await up(s.port); first = await ask(s.port, `lntb30u1p${'q'.repeat(40)}`); rowsBefore = (book().players || []).map((r) => ({ pending: !!r.pending, payers: r.payers })); }
  finally { s.child.kill(); }
  await new Promise((ok) => setTimeout(ok, 300));
  // 2. restarted with a second payer listed first: index 0 is now another lnd
  s = start(['127.0.0.1:2', '127.0.0.1:1']);
  let rowsAfter, again;
  try {
    await up(s.port);
    await new Promise((ok) => setTimeout(ok, 12000));   // a sweep pass (trackpayment of the old payer runs into its 10 s timeout)
    rowsAfter = (book().players || []).map((r) => ({ pending: !!r.pending, payers: r.payers }));
    again = await ask(s.port, `lntb30u1p${'z'.repeat(40)}`);
  } finally { s.child.kill(); }
  const pays = readFileSync(join(dir, 'pays.log'), 'utf8').trim().split('\n');
  console.log('  MEASURED sm4-faucet-2:', JSON.stringify({ first, rowsBefore, rowsAfter, again, pays }));
  assert.equal(first.ok, true);
  assert.deepEqual(rowsBefore, [{ pending: true, payers: [0] }]);
  assert.equal(rowsAfter.length, 1, 'the in-flight welcome must stay on the book: the lnd that holds it was never asked');
  assert.notEqual(again.ok, true, 'no second welcome while the first is still in flight');
});
