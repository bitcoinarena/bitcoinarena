// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-84 skeptic 2 (re-check of #1834 / #2187): a welcome still on its way blocks a second welcome only while its row is in
// `unsure` (or pending in `players`). A row leaves both only through the sweep, by paymentFinal - which reads lncli trackpayment's TEXT output and
// tests /isn't initiated|not initiated|not found|unknown payment/i over ALL of it BEFORE the "Payment status:" line. Without --json lncli 0.21
// prints the payment as a table whose ROUTE column is the hops' node ALIASES (cmd/commands formatPayment + aliasCache.get, present in
// /mnt/bitcoin/lnd-linux-amd64-v0.21.8-beta/lncli). The invoice's destination is the player's own node: a peer that sets its alias to "not found"
// makes every trackpayment of a payment to it read as NONE ("this payer never paid it"), while lnd says IN_FLIGHT (or SUCCEEDED). The sweep then
// forgets the unsure welcome / drops the pending welcome, and the same account is paid a second welcome while the first is still held.
// Attacker role: the payee's Lightning node (a peer), not a client flood. Path: the page's retry ("try again in a few minutes").
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

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-84-s2-'));
  const spec = join(dir, 'spec.json'), paysLog = join(dir, 'pays.log');
  const fake = join(dir, 'lncli');
  // spec.hang: payinvoice does not answer (lncli streams a held payment); spec.htlc: listpayments shows an IN_FLIGHT htlc for it (the payment is out);
  // spec.state: lnd's status of the hash; spec.alias: the destination node's alias, printed in trackpayment's ROUTE column as lncli 0.21 does
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), spec = JSON.parse(fs.readFileSync(${JSON.stringify(spec)}, 'utf8'));
const hash = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const inv = a.find((x) => x.startsWith('lntb')) || '';
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: hash(inv), destination: 'dest' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'payer' })); process.exit(0); }
if (a.includes('payinvoice')) {
  if ((spec.hang || []).includes(hash(inv))) { setTimeout(() => process.exit(1), 30000); return; }
  fs.appendFileSync(${JSON.stringify(paysLog)}, hash(inv) + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0);
}
if (a.includes('trackpayment')) {
  const hh = a[a.indexOf('trackpayment') + 1], st = (spec.state || {})[hh];
  if (!st) { console.error("[lncli] rpc error: code = Unknown desc = payment isn't initiated"); process.exit(1); }
  const alias = spec.alias || 'player-node';
  console.log('+------------+--------------+--------------+--------------+-----+----------+------------------+----------------------+');
  console.log('| HTLC_STATE | ATTEMPT_TIME | RESOLVE_TIME | RECEIVER_AMT | FEE | TIMELOCK | CHAN_OUT         | ROUTE                |');
  console.log('+------------+--------------+--------------+--------------+-----+----------+------------------+----------------------+');
  console.log('| ' + (st === 'SUCCEEDED' ? 'SUCCEEDED ' : 'IN_FLIGHT ') + ' |        0.031 |            - | 3000         | 0   | 123456   | 4422568338866176 | gw-a->' + alias + ' |');
  console.log('+------------+--------------+--------------+--------------+-----+----------+------------------+----------------------+');
  console.log('Amount + fee:   3000 + 0 sat');
  console.log('Payment hash:   ' + hh);
  console.log('Payment status: ' + st + (st === 'SUCCEEDED' ? ', preimage: ' + '00'.repeat(32) : ''));
  if (st === 'IN_FLIGHT') { setTimeout(() => process.exit(0), 30000); return; }   // lncli keeps streaming a payment until it is final
  process.exit(0);
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: Object.entries(spec.state || {}).map(([k, s]) => ({ payment_hash: k, status: s,
  htlcs: (spec.htlc || []).includes(k) ? [{ status: 'IN_FLIGHT' }] : [] })) })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 9000);
  let child = null;
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`,
    FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1200', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '500' };
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

const ACCOUNT = 'ab'.repeat(32);
const INV1 = `lntb30u1p${'w'.repeat(40)}`, INV2 = `lntb30u1p${'x'.repeat(40)}`;

async function run(alias, { out }) {
  const r = rig();
  // out=false: the payment's HTLC shows up only after paymentSent gave up -> the welcome is parked in `unsure`
  // out=true: a held (hodl) invoice: the HTLC is out at once -> the welcome is booked pending
  r.setSpec({ hang: [h(INV1)], htlc: out ? [h(INV1)] : [], state: { [h(INV1)]: 'IN_FLIGHT' }, alias });
  await r.start();
  try {
    const first = await r.ask(ACCOUNT, INV1);
    const mine = () => ({ unsure: (r.book().unsure || []).some((u) => u.account === ACCOUNT && u.kind === 'welcome'),
      pending: (r.book().players || []).some((p) => p.account === ACCOUNT && p.kind === 'welcome' && p.pending) });
    const before = mine();
    // a few sweeps (each trackpayment of a payment still in flight runs to the faucet's 10 s timeout)
    await sleep(13000);
    const afterSweep = mine();
    const second = await r.ask(ACCOUNT, INV2);   // the page's "try again in a few minutes", a new invoice
    return { alias, first: first.ok ? 'paid' : first.why, before, afterSweep, second: second.ok ? 'paid' : second.why,
      secondPayments: r.paid().filter((x) => x === h(INV2)).length, lndSaysFirst: 'IN_FLIGHT' };
  } finally { await r.stop(); }
}

test('#1489 a44-refute-84 s2 (1): payee alias "not found" - the sweep forgets an UNSURE welcome lnd still has IN_FLIGHT, a second welcome is paid', { timeout: 60000 }, async () => {
  const facts = await run('not found', { out: false });
  console.log('  FACTS a44-refute-84 s2 (1):', JSON.stringify(facts));
  assert.equal(facts.before.unsure, true, 'the first welcome is parked in unsure');
  assert.notEqual(facts.second, 'paid', 'a second welcome was paid while the first is still IN_FLIGHT at the payer');
});

test('#1489 a44-refute-84 s2 (2): payee alias "Unknown Payment" - the sweep drops a PENDING (held) welcome, a second welcome is paid', { timeout: 60000 }, async () => {
  const facts = await run('Unknown Payment', { out: true });
  console.log('  FACTS a44-refute-84 s2 (2):', JSON.stringify(facts));
  assert.equal(facts.first, 'paid');
  assert.equal(facts.before.pending, true, 'the first welcome is booked pending');
  assert.notEqual(facts.second, 'paid', 'a second welcome was paid while the first is still IN_FLIGHT at the payer');
});

test('#1489 a44-refute-84 s2 (control): an ordinary alias - the unsure welcome blocks the second (expected to hold)', { timeout: 60000 }, async () => {
  const facts = await run('bob-node', { out: false });
  console.log('  FACTS a44-refute-84 s2 (control):', JSON.stringify(facts));
  assert.notEqual(facts.second, 'paid');
});
