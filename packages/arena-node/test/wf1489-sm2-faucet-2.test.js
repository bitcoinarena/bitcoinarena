// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-faucet-2 (SM-19, the faucet book and its `unsure` list): a welcome whose payinvoice timed out and whose payment showed no HTLC in
// flight by PAY_SETTLE_MS (the payment itself still IN_FLIGHT, lnd retrying routes) is taken off `players` and parked in `unsure`. playerGrantDecide
// reads `players` only, so the same account's next welcome ask (a new invoice) is paid at once. When the first payment then SUCCEEDS, the sweep books
// it again ("paid after all") - the account holds two welcomes, which playerGrantDecide promises never happens ("Never paid twice as a welcome").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('#1489 sm2-faucet-2: an account is never paid two welcomes (one parked in unsure, one asked again)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-2-'));
  // first: payinvoice hangs; the payment exists, IN_FLIGHT, its attempts so far FAILED (lnd retrying a route); trackpayment says IN_FLIGHT
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'hang', state: 'IN_FLIGHT' }));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'spec.json'))}, 'utf8'));
const last = a[a.length - 1];
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: require('crypto').createHash('sha256').update(last).digest('hex'), destination: 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k1' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (spec.pay === 'ok') { fs.appendFileSync(${JSON.stringify(join(dir, 'paid.log'))}, last + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }
  setTimeout(() => process.exit(1), 20000); return;
}
if (a.includes('trackpayment')) { console.log('Payment status: ' + spec.state); process.exit(0); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: spec.first ? [{ payment_hash: spec.first, status: spec.state, htlcs: [{ status: 'FAILED' }] }] : [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const inv1 = `lntb30u1p${'q'.repeat(40)}`, inv2 = `lntb30u1p${'z'.repeat(40)}`;
  const { createHash } = await import('node:crypto');
  const h1 = createHash('sha256').update(inv1).digest('hex');
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'hang', state: 'IN_FLIGHT', first: h1 }));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_PAY_WAIT_MS: '600', FAUCET_PAY_SETTLE_MS: '1200', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  const account = 'cd'.repeat(32);
  const ask = (invoice) => fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
    body: JSON.stringify({ kind: 'welcome', account, invoice }) }).then((r) => r.json());
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const first = await ask(inv1);
    const book1 = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
    // the page asks again (the player taps once more); payer now pays at once
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'ok', state: 'IN_FLIGHT', first: h1 }));
    const second = await ask(inv2);
    // the first payment lands after all
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ pay: 'ok', state: 'SUCCEEDED', first: h1 }));
    await sleep(1500);
    const rows = (JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')).players || []).filter((x) => x.account === account && x.kind === 'welcome');
    console.log('  MEASURED sm2-faucet-2:', JSON.stringify({ first, unsureAfterFirst: (book1.unsure || []).length, second, welcomeRows: rows.length,
      paidByFaucet: existsSync(join(dir, 'paid.log')) ? readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').length : 0 }));
    // the invariant: one welcome per account, whatever the order of answers
    assert.ok(rows.length <= 1, `the account holds ${rows.length} welcomes`);
  } finally { child.kill('SIGKILL'); }
});

test('#1628: an unsure welcome refuses the welcome, unsure top-ups count toward the day', async () => {
  const { playerGrantDecide, PLAYER_TOPUPS_PER_DAY } = await import('../src/faucet.js');
  const account = 'ab'.repeat(32), nowMs = Date.now();
  const w = playerGrantDecide({ kind: 'welcome', account, invoiceSats: 3000, nowMs }, { players: [], unsure: [{ account, kind: 'welcome', sats: 3000, atMs: nowMs - 1000, hash: 'h' }] });
  assert.equal(w.ok, false);
  assert.match(w.why, /still being checked/);
  assert.equal(playerGrantDecide({ kind: 'welcome', account: 'ef'.repeat(32), invoiceSats: 3000, nowMs }, { players: [], unsure: [{ account, kind: 'welcome', sats: 3000, atMs: nowMs, hash: 'h' }] }).ok, true);
  const unsure = Array.from({ length: PLAYER_TOPUPS_PER_DAY }, (_, i) => ({ account, kind: 'topup', sats: 300, atMs: nowMs - i, hash: `h${i}` }));
  assert.equal(playerGrantDecide({ kind: 'topup', account, invoiceSats: 300, nowMs }, { players: [], unsure }).ok, false);
  assert.equal(playerGrantDecide({ kind: 'topup', account, invoiceSats: 300, nowMs }, { players: [], unsure: unsure.slice(1) }).ok, true);
});
