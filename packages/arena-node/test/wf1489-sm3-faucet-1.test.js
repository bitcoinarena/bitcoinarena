// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm3-faucet-1 (state machine audit, faucet book SM-19): a welcome whose payment timed out is taken off the book and kept in `unsure`,
// because "a payer that timed out may still pay it" (#1421). playerGrantDecide reads only book.players, so while the first payment is still IN_FLIGHT
// at the payer the same account is granted a second welcome on a new invoice (the page's "try again in a minute"). When the first payment then
// SUCCEEDS, the sweep books it again next to the second: one account, two welcomes paid. Invariant: an account is paid one welcome.
// The real tools/faucet.mjs against a fake lncli whose payment hash is the invoice's own (sha256 of it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const h = (s) => createHash('sha256').update(s).digest('hex');

test('#1489 sm3-faucet-1: a welcome still in flight is not granted a second time to the same account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm3-faucet-1-'));
  const spec = join(dir, 'spec.json'), paysLog = join(dir, 'pays.log');
  const INV1 = `lntb30u1p${'q'.repeat(40)}`, INV2 = `lntb30u1p${'z'.repeat(40)}`;
  // hang: payinvoice of this hash does not answer (lnd still looking for a route); state: the payment's status at the payer (trackpayment / listpayments)
  writeFileSync(spec, JSON.stringify({ hang: [h(INV1)], state: { [h(INV1)]: 'IN_FLIGHT' } }));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(spec)}, 'utf8'));
const hash = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const inv = a.find((x) => x.startsWith('lntb')) || '';
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: hash(inv), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'payer' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (spec.hang.includes(hash(inv))) { setTimeout(() => process.exit(1), 30000); return; }
  fs.appendFileSync(${JSON.stringify(paysLog)}, hash(inv) + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0);
}
if (a.includes('trackpayment')) {
  const hh = a[a.indexOf('trackpayment') + 1], st = spec.state[hh];
  if (!st) { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  console.log('Payment status: ' + st); process.exit(0);
}
if (a.includes('listpayments')) {
  // lnd's payment is IN_FLIGHT with no HTLC yet while it looks for a route
  console.log(JSON.stringify({ payments: Object.entries(spec.state).map(([k, s]) => ({ payment_hash: k, status: s, htlcs: [] })) })); process.exit(0);
}
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`,
    FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1200', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' } });
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  const ACCOUNT = 'cd'.repeat(32);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async (invoice) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ kind: 'welcome', account: ACCOUNT, invoice }) })).json();
    const first = await ask(INV1);
    await new Promise((ok) => setTimeout(ok, 700));   // two sweeps: the first payment is still IN_FLIGHT, kept in unsure
    const unsureAfterFirst = (book().unsure || []).map((u) => u.hash.slice(0, 8));
    const second = await ask(INV2);
    // the first payment now goes through after all
    writeFileSync(spec, JSON.stringify({ hang: [h(INV1)], state: { [h(INV1)]: 'SUCCEEDED', [h(INV2)]: 'SUCCEEDED' } }));
    await new Promise((ok) => setTimeout(ok, 1200));
    const welcomes = (book().players || []).filter((p) => p.account === ACCOUNT && p.kind === 'welcome');
    let paid = []; try { paid = readFileSync(paysLog, 'utf8').trim().split('\n').filter(Boolean); } catch { paid = []; }
    const facts = { first: first.ok ? 'paid' : first.why, unsureAfterFirst, second: second.ok ? 'paid' : second.why,
      paymentsSucceeded: [h(INV1), ...paid].filter((x, i, s) => s.indexOf(x) === i).length, welcomeRowsBooked: welcomes.length };
    console.log('  FACTS sm3-faucet-1:', JSON.stringify(facts));
    assert.equal(facts.first, 'the faucet could not pay just now: try again in a minute');
    assert.equal(unsureAfterFirst.length, 1, 'the first welcome is kept as unsure: its payer may still pay it');
    assert.ok(welcomes.length <= 1, `one account holds ${welcomes.length} welcomes in the book (two payments of 3,000 sat SUCCEEDED)`);
    assert.notEqual(facts.second, 'paid', 'a second welcome was paid while the first one was still in flight');
  } finally { child.kill(); }
});
