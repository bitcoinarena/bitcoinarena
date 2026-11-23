// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT faucet a5-1-1: a stranger's HELD invoices hold the faucet's one payment queue (one()), so an honest player's welcome waits behind them.
// POST /player pays each invoice inside one() - shared by every welcome, top-up, e-cash welcome and the installer's POST /faucet - and a payinvoice
// whose HTLC the payee holds (a hold invoice) runs until PAY_WAIT_MS (15 s) before it is booked pending and the next ask is taken. Accounts cost
// nothing and top-ups need no welcome first, so three held top-ups in front of a new player use up the page's whole 45 s wait (askFaucet,
// AbortSignal.timeout(45000) = 3 x PAY_WAIT_MS): the faucet then drops the welcome ('the page stopped waiting'). The held HTLCs are cancelled later,
// the sweep takes the rows out again, and no sat ever leaves the faucet - the stranger can keep this up for as long as he likes.
// The real tools/faucet.mjs against a fake lncli; PAY_WAIT_MS 1000, so the page's wait is 3000 ms here.
// SAFE BEHAVIOUR asserted: an honest welcome from another network is answered within the page's wait while a stranger's held top-ups are paying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const PAY_WAIT_MS = 1000;

test('audit faucet a5-1-1: a stranger\'s held top-up invoices do not hold an honest welcome past the page\'s wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-a5-1-1-'));
  const fake = join(dir, 'lncli');
  // decodepayreq: an invoice with 'hold' in it is a 300 sat top-up invoice of the stranger's node, any other a 3000 sat welcome invoice;
  // each invoice has its own payment hash. payinvoice: the stranger's node holds the HTLC (IN_FLIGHT, no end); the honest one SUCCEEDS at once
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), inv = a[a.length - 1];
const hash = require('crypto').createHash('sha256').update(inv).digest('hex');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: inv.includes('hold') ? '300' : '3000', num_msat: inv.includes('hold') ? '300000' : '3000000', payment_hash: hash, destination: inv.includes('hold') ? '02' + 'ee'.repeat(32) : '02' + 'aa'.repeat(32) })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: '03' + 'bb'.repeat(32) })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (!inv.includes('hold')) { console.log('Payment hash: ' + hash + '\\nPayment status: SUCCEEDED, preimage: ' + 'cd'.repeat(32)); process.exit(0); }
  console.log('Payment status: IN_FLIGHT'); setTimeout(() => process.exit(1), 60000); return;
}
if (a.includes('trackpayment')) { console.log('Payment status: IN_FLIGHT'); process.exit(0); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_PAY_WAIT_MS: String(PAY_WAIT_MS), FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '600000' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/player`;
  const post = (ip, body, signal) => fetch(base, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body), signal }).then((r) => r.json());
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(base); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    // THE STRANGER: six top-ups from six fresh accounts, one IPv4 address of another network, each a hold invoice of his own node
    const held = [];
    for (let i = 0; i < 6; i++) {
      const account = (i + 1).toString(16).padStart(2, '0').repeat(32);
      held.push(post('203.0.113.7', { kind: 'topup', account, invoice: `lntb3u1phold${String(i).repeat(30)}` }).catch((e) => ({ ok: false, why: e.message })));
    }
    await new Promise((ok) => setTimeout(ok, 150));
    // THE HONEST NEW PLAYER: a welcome, asked as the page asks it - it stops waiting after 3 x PAY_WAIT_MS (the page's 45 s for 15 s)
    const t0 = Date.now();
    let honest;
    try { honest = await post('198.51.100.9', { kind: 'welcome', account: 'ab'.repeat(32), invoice: `lntb30u1pgood${'q'.repeat(30)}` }, AbortSignal.timeout(3 * PAY_WAIT_MS)); }
    catch (e) { honest = { ok: false, why: `the page stopped waiting after ${Date.now() - t0} ms (${e.name})` }; }
    const strangers = await Promise.all(held);
    console.log('  MEASURED a5-1-1 stranger top-ups:', JSON.stringify(strangers.map((x) => (x.ok ? (x.pending ? 'pending' : 'paid') : x.why))));
    console.log('  MEASURED a5-1-1 honest welcome:', JSON.stringify(honest));
    // the stranger's held top-ups were all taken as 'sent' (booked pending): nothing stopped them
    assert.ok(strangers.every((x) => x.ok && x.pending), 'the stranger\'s held top-ups were each booked pending');
    // SAFE: the honest welcome is answered paid within the page's wait
    assert.equal(honest.ok, true, `the honest welcome must be answered within the page's wait, got: ${honest.why}`);
  } finally { child.kill(); }
});
