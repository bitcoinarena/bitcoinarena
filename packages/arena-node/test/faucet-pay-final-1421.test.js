// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1421 (audit 6 for 2026.1.9.27): the faucet's paid/not-paid verdict was taken before the payment was final and never read again.
// The real tools/faucet.mjs against a fake lncli: each payer's payinvoice fails at once, times out, or succeeds; after a timeout its payment's
// own state (listpayments) is FAILED, held in flight (the federation's incoming contract), or nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ab'.repeat(32);
// payers: { 'rpc': { pay, state } }, changed by the test while the faucet runs; the sweep (FAUCET_SWEEP_MS) reads each payer's final word
async function run(payers, after) {
  const dir = mkdtempSync(join(tmpdir(), 'faucet1421-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(payers));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), spec = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'spec.json'))}, 'utf8'));
const me = spec[(a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12)] || {};
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '500', payment_hash: '${HASH}', destination: spec.destination || 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: me.key || 'k-' + (a.find((x) => x.startsWith('--rpcserver=')) || '') })); process.exit(0); }
if (a.includes('payinvoice')) require('fs').appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, ((a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12)) + '\\n');
if (a.includes('payinvoice')) {
  if (me.pay === 'fail') { console.error('[lncli] rpc error: self-payments not allowed'); process.exit(1); }
  if (me.pay === 'ok') { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  setTimeout(() => process.exit(1), 30000); return;
}
if (a.includes('trackpayment')) {
  if (me.state === 'NONE') { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  // AS LNCLI 0.21 PRINTS IT (audit 7, kanban #1430): JSON only with --json (the payment's status, then its htlcs'), else a table and "Payment status: X"
  const st = me.state === 'HELD' ? 'IN_FLIGHT' : me.state;
  if (a.includes('--json')) { console.log(JSON.stringify({ payment_hash: '${HASH}', status: st, htlcs: [{ status: st === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED' }] })); process.exit(0); }
  console.log('+------------+--------------+\\n| HOP_CHAN_ID | LAST_HOP_ALIAS |\\n+------------+--------------+');
  console.log('Payment status: ' + st + (st === 'SUCCEEDED' ? ', preimage: ' + 'ab'.repeat(32) : '')); process.exit(0);
}
if (a.includes('listpayments')) {
  const p = me.state === 'NONE' ? [] : [{ payment_hash: '${HASH}', status: me.state === 'HELD' ? 'IN_FLIGHT' : me.state, htlcs: me.state === 'HELD' ? [{ status: 'IN_FLIGHT' }] : [] }];
  console.log(JSON.stringify({ payments: p })); process.exit(0);
}
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'),
    FAUCET_PAYERS: Object.keys(payers).filter((k) => k !== 'destination').map((rpc) => `${dir}|${rpc}`).join(','), FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async () => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' }, body: JSON.stringify({ kind: 'welcome', account: 'cd'.repeat(32), invoice: `lntb5u1p${'q'.repeat(40)}` }) })).json();
    const first = await ask();
    const before = (book().players || []).map((x) => (x.pending ? 'pending' : 'booked'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(after));
    await new Promise((ok) => setTimeout(ok, 1500));
    const rows = (book().players || []).map((x) => (x.pending ? 'pending' : 'booked'));
    const again = await ask();
    return { first: first.ok, before, rows, again: again.ok ? 'paid again' : again.why };
  } finally { child.kill(); }
}

test('#1421 an in-flight welcome that then FAILED is taken off the book (the welcome can be asked again)', async () => {
  const r = await run({ '127.0.0.1:1': { pay: 'timeout', state: 'HELD' } }, { '127.0.0.1:1': { pay: 'timeout', state: 'FAILED' } });
  console.log('  MEASURED #1421 in flight -> FAILED:', JSON.stringify(r));
  assert.deepEqual([r.first, r.before, r.rows], [true, ['pending'], []]);
});

test('#1421 a welcome given up on that a payer then paid is booked again (no second welcome)', async () => {
  const r = await run({ '127.0.0.1:1': { pay: 'timeout', state: 'NONE' } }, { '127.0.0.1:1': { pay: 'timeout', state: 'SUCCEEDED' } });
  console.log('  MEASURED #1421 not paid -> SUCCEEDED later:', JSON.stringify(r));
  assert.deepEqual([r.first, r.before, r.rows], [false, [], ['booked']]);
  assert.match(String(r.again), /already has its welcome/);
});
