// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 6 (#1627): the second copy of the booked-before-pay logic: POST /refill books its row plain before payinvoice and only an in-memory
// 120 s timer ever takes a failed one out. A faucet killed inside payinvoice (or within 120 s after an IN_FLIGHT answer) keeps a refill that was never
// paid counted toward REFILL_DAY_CAP_SATS for the day: the sweep (#1627) reads players and unsure only, never refills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// spec: { <rpcserver>: { pay: 'hang'|'ok'|'no'|'inflight', track: { <invoice-prefix>: 'NONE'|'SUCCEEDED'|'FAILED'|'IN_FLIGHT' } } }
function rig(nPayers) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-r6-'));
  const specFile = join(dir, 'spec.json');
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(specFile)}, 'utf8'));
const rpc = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12), me = spec[rpc] || {};
const inv = a[a.length - 1], hashOf = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: String(spec.amount || 3000), payment_hash: hashOf(inv), destination: 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + rpc })); process.exit(0); }
if (a.includes('payinvoice')) {
  fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, rpc + ' ' + hashOf(inv) + '\\n');
  if (me.pay === 'ok') { fs.appendFileSync(${JSON.stringify(join(dir, 'paid.log'))}, rpc + ' ' + hashOf(inv) + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }
  if (me.pay === 'inflight') { console.log('Payment status: IN_FLIGHT'); process.exit(0); }
  if (me.pay === 'no') { console.error('[lncli] payment failed: no route'); process.exit(1); }
  setTimeout(() => process.exit(1), 30000); return;
}
if (a.includes('trackpayment')) {
  const t = (me.track || {})[inv];
  if (t === 'SUCCEEDED' || t === 'FAILED' || t === 'IN_FLIGHT') { console.log('Payment status: ' + t); process.exit(0); }
  const paid = fs.existsSync(${JSON.stringify(join(dir, 'paid.log'))}) && fs.readFileSync(${JSON.stringify(join(dir, 'paid.log'))}, 'utf8').includes(rpc + ' ' + inv);
  if (paid) { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1);
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const rpcs = Array.from({ length: nPayers }, (_, i) => `127.0.0.1:${i + 1}`);
  const port = 20000 + Math.floor(Math.random() * 10000);
  writeFileSync(join(dir, 'token'), 'refill-token-xyz');
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_REFILL_TOKEN_FILE: join(dir, 'token'),
    FAUCET_PAYERS: rpcs.map((r) => `${dir}|${r}`).join(','), FAUCET_PAY_WAIT_MS: '8000', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' };
  const spec = (s) => writeFileSync(specFile, JSON.stringify(s));
  const start = async () => {
    const c = spawn(process.execPath, [FAUCET], { env, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    return c;
  };
  const ask = (kind, account, invoice) => fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' },
    body: JSON.stringify({ kind, account, invoice }) }).then((r) => r.json(), (e) => ({ ok: false, why: `no answer: ${e.message}` }));
  const refill = (invoice) => fetch(`http://127.0.0.1:${port}/refill`, { method: 'POST', body: JSON.stringify({ token: 'refill-token-xyz', invoice }) })
    .then((r) => r.json(), (e) => ({ ok: false, why: `no answer: ${e.message}` }));
  const lines = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []);
  const book = () => JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
  const waitFor = async (f, n) => { for (let i = 0; i < 200 && lines(f).length < n; i++) await sleep(50); };
  return { rpcs, spec, start, ask, refill, lines, book, waitFor };
}
const INV1 = `lntb30u1p${'q'.repeat(40)}`, INV2 = `lntb30u1p${'z'.repeat(40)}`;

test('v5 (second copy, POST /refill): a refill killed inside payinvoice is not counted for the day after the restart', async () => {
  const r = rig(1); const [a] = r.rpcs;
  r.spec({ [a]: { pay: 'hang' } });
  let c = await r.start();
  try {
    const first = r.refill(INV1);
    await r.waitFor('pays.log', 1); c.kill('SIGKILL'); await first;
    r.spec({ [a]: { pay: 'ok' } });
    c = await r.start(); await sleep(1500);
    const refills = r.book().refills || [];
    console.log('  MEASURED v5', JSON.stringify({ refills, paid: r.lines('paid.log').length }));
    assert.equal(refills.length, 0, 'a refill never paid (payer: not initiated) still counts toward the day cap');
  } finally { c.kill('SIGKILL'); }
});
