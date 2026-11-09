// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1381 (Daniel 2026-11-09: a new wallet's test sats never arrived): the players' faucet answers "paid" only for a payment on its way.
// The real tools/faucet.mjs against a fake lncli: each payer's payinvoice fails at once, times out, or succeeds; after a timeout its payment's
// own state (listpayments) is FAILED, held in flight (the federation's incoming contract), or nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ab'.repeat(32);
// payers: { 'rpc': { pay: 'fail' | 'timeout' | 'ok', state: 'FAILED' | 'HELD' | 'NONE' | 'SUCCEEDED' } }
async function ask(payers) {
  const dir = mkdtempSync(join(tmpdir(), 'faucet1381-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(payers));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), spec = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'spec.json'))}, 'utf8'));
const me = spec[(a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12)] || {};
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '500', payment_hash: '${HASH}' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (me.pay === 'fail') { console.error('[lncli] rpc error: self-payments not allowed'); process.exit(1); }
  if (me.pay === 'ok') { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  setTimeout(() => process.exit(1), 30000); return;
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
    FAUCET_PAYERS: Object.keys(payers).map((rpc) => `${dir}|${rpc}`).join(','), FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const r = await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', body: JSON.stringify({ kind: 'welcome', account: 'cd'.repeat(32), invoice: `lntb5u1p${'q'.repeat(40)}` }) });
    return await r.json();
  } finally { child.kill(); }
}

test('#1381 a payment that times out and then FAILED (no route) is not told as paid', async () => {
  const r = await ask({ '127.0.0.1:1': { pay: 'timeout', state: 'FAILED' } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.why, /try again/);
});

test('#1381 a payment that times out while the federation holds it in flight is paid', async () => {
  assert.deepEqual(await ask({ '127.0.0.1:1': { pay: 'timeout', state: 'HELD' } }), { ok: true, sats: 500 });
});

test('#1381 a payment that times out and never went out is not paid', async () => {
  assert.equal((await ask({ '127.0.0.1:1': { pay: 'timeout', state: 'NONE' } })).ok, false);
});

test('#1381 the 11-09 case: payer a cannot pay its own gateway, payer b finds no route - not paid; with b\'s route back, paid', async () => {
  assert.equal((await ask({ '127.0.0.1:1': { pay: 'fail' }, '127.0.0.1:2': { pay: 'timeout', state: 'FAILED' } })).ok, false);
  assert.deepEqual(await ask({ '127.0.0.1:1': { pay: 'fail' }, '127.0.0.1:2': { pay: 'ok' } }), { ok: true, sats: 500 });
  assert.deepEqual(await ask({ '127.0.0.1:1': { pay: 'fail' }, '127.0.0.1:2': { pay: 'timeout', state: 'SUCCEEDED' } }), { ok: true, sats: 500 });
});
