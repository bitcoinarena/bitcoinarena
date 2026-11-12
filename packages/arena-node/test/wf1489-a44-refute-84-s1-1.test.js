// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-84 (re-check of #1834): a welcome kept in `unsure` blocks a second welcome to the same account - only while its row is in
// `unsure`. grantPay keeps that list to its newest 500 rows (.slice(-500)), and every grant that fails at once (an invoice with no route) is parked
// there too, decided ok and counted toward the caps only while it is there. A stranger with 500 throw-away accounts (three addresses: 200 a day each)
// and invoices no payer can route pushes the account's own unsure welcome out of the list before the next sweep (120 s): the account is then asked
// "already has its welcome" nowhere, is paid a second welcome, and when the first payment lands the sweep no longer knows it (two welcomes paid).
// Also checked here (expected to hold): the same welcome across a restart of the faucet, and the honest retry once the first payment FAILED.
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
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function rig(sweepMs) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-84-'));
  const spec = join(dir, 'spec.json'), paysLog = join(dir, 'pays.log');
  const fake = join(dir, 'lncli');
  // spec: hang = hashes whose payinvoice does not answer; fail = hashes whose payinvoice FAILS at once (no route); state = trackpayment/listpayments
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(spec)}, 'utf8'));
const hash = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const inv = a.find((x) => x.startsWith('lntb')) || '';
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: hash(inv), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'payer' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if ((spec.hang || []).includes(hash(inv))) { setTimeout(() => process.exit(1), 30000); return; }
  if (spec.failAll || (spec.fail || []).includes(hash(inv))) { console.log('Payment status: FAILED, reason: FAILURE_REASON_NO_ROUTE'); process.exit(1); }
  fs.appendFileSync(${JSON.stringify(paysLog)}, hash(inv) + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0);
}
if (a.includes('trackpayment')) {
  const hh = a[a.indexOf('trackpayment') + 1], st = (spec.state || {})[hh] || (spec.failAll ? 'FAILED' : null);
  if (!st) { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  console.log('Payment status: ' + st); process.exit(0);
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: Object.entries(spec.state || {}).map(([k, s]) => ({ payment_hash: k, status: s, htlcs: [] })) })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 9000);
  let child = null;
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`,
    FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1200', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: String(sweepMs) };
  const start = async () => {
    child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env });
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); return; } catch { await sleep(100); } }
  };
  const stop = async () => { if (child) { child.kill(); await new Promise((ok) => child.once('exit', ok)); child = null; } };
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  const setSpec = (s) => writeFileSync(spec, JSON.stringify(s));
  const ask = async (account, invoice, ip = '198.51.100.9') => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': ip },
    body: JSON.stringify({ kind: 'welcome', account, invoice }) })).json();
  const paid = () => { try { return readFileSync(paysLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { start, stop, book, setSpec, ask, paid };
}

const ACCOUNT = 'cd'.repeat(32);
const INV1 = `lntb30u1p${'q'.repeat(40)}`, INV2 = `lntb30u1p${'z'.repeat(40)}`;

test('#1489 a44-refute-84 (1): 500 failed throw-away welcomes push the account\'s unsure welcome out - a second welcome is paid', { timeout: 115000 }, async () => {
  const r = rig(120000);   // the faucet's own default sweep
  r.setSpec({ hang: [h(INV1)], state: { [h(INV1)]: 'IN_FLIGHT' }, failAll: false, fail: [] });
  await r.start();
  try {
    const first = await r.ask(ACCOUNT, INV1);
    const unsureMine = () => (r.book().unsure || []).some((u) => u.account === ACCOUNT && u.kind === 'welcome');
    const before = unsureMine();
    // 500 throw-away accounts, invoices no payer can route: each FAILS at once and is parked in `unsure`
    const junk = [];
    for (let i = 0; i < 500; i++) junk.push(`lntb30u1p${i.toString(36).padStart(6, '0')}${'j'.repeat(34)}`);
    r.setSpec({ hang: [h(INV1)], state: { [h(INV1)]: 'IN_FLIGHT' }, fail: junk.map(h) });
    const t0 = Date.now();
    for (let i = 0; i < 500; i++) {
      const acct = createHash('sha256').update(`junk-${i}`).digest('hex');
      await r.ask(acct, junk[i], `203.0.113.${1 + Math.floor(i / 190)}`);
      if (Date.now() - t0 > 90000) break;
    }
    const after = unsureMine();
    const second = await r.ask(ACCOUNT, INV2);
    const facts = { first: first.why || 'paid', unsureBefore: before, unsureAfterFlood: after, floodMs: Date.now() - t0, unsureRows: (r.book().unsure || []).length,
      second: second.ok ? 'paid' : second.why, secondPaymentsMade: r.paid().filter((x) => x === h(INV2)).length };
    console.log('  FACTS a44-refute-84 (1):', JSON.stringify(facts));
    assert.equal(before, true, 'the first welcome is kept as unsure');
    assert.notEqual(facts.second, 'paid', 'a second welcome was paid to the account while its first welcome is still IN_FLIGHT at the payer');
  } finally { await r.stop(); }
});

test('#1489 a44-refute-84 (2): an unsure welcome still blocks the same account after the faucet restarts', { timeout: 60000 }, async () => {
  const r = rig(600000);
  r.setSpec({ hang: [h(INV1)], state: { [h(INV1)]: 'IN_FLIGHT' } });
  await r.start();
  try {
    const first = await r.ask(ACCOUNT, INV1);
    await r.stop(); await r.start();
    const second = await r.ask(ACCOUNT, INV2);
    console.log('  FACTS a44-refute-84 (2):', JSON.stringify({ first: first.why, second: second.ok ? 'paid' : second.why }));
    assert.notEqual(second.ok, true);
  } finally { await r.stop(); }
});

test('#1489 a44-refute-84 (3): honest path - once the first payment FAILED and the sweep forgot it, the account is paid its welcome', { timeout: 60000 }, async () => {
  const r = rig(300);
  r.setSpec({ hang: [h(INV1)], state: { [h(INV1)]: 'IN_FLIGHT' } });
  await r.start();
  try {
    const first = await r.ask(ACCOUNT, INV1);
    const meanwhile = await r.ask(ACCOUNT, INV2);
    r.setSpec({ hang: [h(INV1)], state: { [h(INV1)]: 'FAILED' } });
    let unsure = 1; for (let i = 0; i < 40 && unsure; i++) { await sleep(150); unsure = (r.book().unsure || []).length; }
    const again = await r.ask(ACCOUNT, INV2);
    const facts = { first: first.why, meanwhile: meanwhile.ok ? 'paid' : meanwhile.why, unsureLeft: unsure, again: again.ok ? 'paid' : again.why,
      welcomes: (r.book().players || []).filter((p) => p.account === ACCOUNT && p.kind === 'welcome').length };
    console.log('  FACTS a44-refute-84 (3):', JSON.stringify(facts));
    assert.equal(facts.again, 'paid');
    assert.equal(facts.welcomes, 1);
  } finally { await r.stop(); }
});
