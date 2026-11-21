// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 6 skeptic 2 (#1627, #2130): retry/reload paths of POST /refill. The first copy of the booked-before-pay logic: POST /refill books its row plain before payinvoice and only an in-memory
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
  const paidLog = ${JSON.stringify(join(dir, 'paid.log'))}, already = fs.existsSync(paidLog) ? fs.readFileSync(paidLog, 'utf8') : '';
  if (already.includes(rpc + ' ' + hashOf(inv))) { console.error('[lncli] rpc error: invoice is already paid'); process.exit(1); }
  if (already.includes(' ' + hashOf(inv))) { console.log('Payment status: FAILED, reason: FAILURE_REASON_INCORRECT_PAYMENT_DETAILS'); process.exit(0); }
  if (me.pay === 'slowok') { setTimeout(() => { fs.appendFileSync(paidLog, rpc + ' ' + hashOf(inv) + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }, 2500); fs.appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, rpc + ' ' + hashOf(inv) + '\\n'); fs.writeFileSync(${JSON.stringify(join(dir, 'busy'))}, hashOf(inv)); return; }
  if (fs.existsSync(${JSON.stringify(join(dir, 'busy'))}) && fs.readFileSync(${JSON.stringify(join(dir, 'busy'))}, 'utf8') === hashOf(inv)) {
    if (me.pay === 'busy') { console.error('[lncli] rpc error: payment is in transition'); process.exit(1); }
    console.log('Payment status: FAILED, reason: FAILURE_REASON_INCORRECT_PAYMENT_DETAILS'); process.exit(0);
  }
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


const today = (b) => (b.refills || []).reduce((n, x) => n + x.sats, 0);

test('s2-1 retry: the bot POSTs the same invoice again after it was paid - the paid refill leaves the day count', async () => {
  const r = rig(2); const [a, b] = r.rpcs;
  r.spec({ [a]: { pay: 'ok' }, [b]: { pay: 'ok' } });
  const c = await r.start();
  try {
    const one = await r.refill(INV1);
    assert.equal(one.ok, true, JSON.stringify(one));
    const before = today(r.book());
    const again = await r.refill(INV1);   // the bot never saw the first answer (its fetch timed out) and asks again
    await sleep(800);
    const bk = r.book();
    console.log('  MEASURED s2-1', JSON.stringify({ one, again, before, after: today(bk), refills: bk.refills, paid: r.lines('paid.log').length }));
    assert.equal(r.lines('paid.log').length, 1, 'paid once');
    assert.equal(today(bk), 3000, 'a refill that moved 3000 sat is no longer counted toward REFILL_DAY_CAP_SATS');
  } finally { c.kill('SIGKILL'); }
});

test('s2-2 concurrent retry: a second POST of the same invoice while the first is still paying removes the first one\'s row', async () => {
  const r = rig(2); const [a, b] = r.rpcs;
  r.spec({ [a]: { pay: 'slowok' }, [b]: { pay: 'ok' } });
  const c = await r.start();
  try {
    const first = r.refill(INV2);
    await r.waitFor('pays.log', 1);
    r.spec({ [a]: { pay: 'busy' }, [b]: { pay: 'ok' } });   // payer a: "payment is in transition"; payer b's try fails at the destination
    const second = await r.refill(INV2);
    r.spec({ [a]: { pay: 'slowok' }, [b]: { pay: 'ok' } });
    const one = await first;
    await sleep(800);
    const bk = r.book();
    console.log('  MEASURED s2-2', JSON.stringify({ one, second, after: today(bk), refills: bk.refills, paid: r.lines('paid.log').length }));
    assert.equal(r.lines('paid.log').length, 1, 'paid once');
    assert.equal(today(bk), 3000, 'the paid refill was taken out of the day count by the concurrent retry');
  } finally { c.kill('SIGKILL'); }
});
