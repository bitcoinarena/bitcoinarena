// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2285): 1.9 refuses an invoice whose hash any row holds before booking (#2473, #2505), so the second
// account's welcome on the same invoice books nothing; the invariant is checked as the card states it: no unpaid row booked final, and B gets
// its welcome once it asks with its own invoice.
// kanban #1489 sm9-faucet-2 (state-machine audit, SM-19 pending verdict): grant() marks its row pending after a payinvoice that is not final by finding
// THE FIRST ROW WITH THE INVOICE'S PAYMENT HASH (`(b2.players).find((x) => x.hash === row.hash)`), not its own row. One invoice can be sent under any
// number of accounts (the decode is all that names the hash). Account A's welcome on invoice I is pending (in flight at payer 0); account B's welcome on
// the same I goes out at payer 1 and is not final either - the faucet marks A's row (pending already) and leaves B's row booked as a FINAL grant. B's
// payment then FAILS: the sweep reads only pending rows, so B's row stays booked for good - B was paid nothing, and is answered "already has its
// welcome" from then on (and the sweep's by-hash drop, run on A's FAILED, would take any row of that hash with it).
// Invariant: a welcome whose payment is not final is booked pending; a row leaves or stays only on its own payers' final word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ab'.repeat(32);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('#1489 sm9-faucet-2: a second account\'s in-flight welcome on the same invoice is booked final; when it FAILS that account never gets its welcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm9-faucet-2-'));
  const spec = (s) => writeFileSync(join(dir, 'spec.json'), JSON.stringify(s));
  // payer 0 holds A's payment in flight; B's payinvoice at payer 0 is refused at once (the hash is in transition there), payer 1 holds B's
  spec({ '127.0.0.1:1': { pay: 'timeout', state: 'HELD' }, '127.0.0.1:2': { pay: 'timeout', state: 'HELD' } });
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), spec = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'spec.json'))}, 'utf8'));
const me = spec[(a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12)] || {};
const inv = a[a.length - 1];
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: inv.includes('zz') ? '3000' : '500', payment_hash: inv.includes('zz') ? 'cd'.repeat(32) : '${HASH}', destination: 'none' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + (a.find((x) => x.startsWith('--rpcserver=')) || '') })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (inv.includes('zz')) { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  if (me.pay === 'fail') { console.error('[lncli] rpc error: payment is in transition'); process.exit(1); }
  if (me.pay === 'ok') { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  setTimeout(() => process.exit(1), 30000); return;
}
if (a.includes('trackpayment')) {
  if (me.state === 'NONE') { console.error("[lncli] rpc error: payment isn't initiated"); process.exit(1); }
  const st = me.state === 'HELD' ? 'IN_FLIGHT' : me.state;
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
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake,
    FAUCET_PAYERS: `${dir}|127.0.0.1:1,${dir}|127.0.0.1:2`, FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '1500', FAUCET_PAY_POLL_MS: '200', FAUCET_SWEEP_MS: '300' }, stdio: 'ignore' });
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  const rows = () => (book().players || []).map((x) => `${x.account.slice(0, 2)}:${x.pending ? 'pending' : 'booked'}`);
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32);
  const ask = async (account, invoice, ip) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': ip },
    body: JSON.stringify({ kind: 'welcome', account, invoice }) })).json();
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const SAME = `lntb5u1p${'q'.repeat(40)}`;
    const a = await ask(A, SAME, '198.51.100.1');
    spec({ '127.0.0.1:1': { pay: 'fail', state: 'HELD' }, '127.0.0.1:2': { pay: 'timeout', state: 'HELD' } });
    const b = await ask(B, SAME, '198.51.100.2');
    const both = rows();
    // both attempts FAILED in the end: nobody was paid
    spec({ '127.0.0.1:1': { pay: 'fail', state: 'FAILED' }, '127.0.0.1:2': { pay: 'timeout', state: 'FAILED' } });
    await sleep(2000);
    const afterSweep = rows();
    const bAgain = await ask(B, `lntb30u1p${'zz'.repeat(20)}`, '198.51.100.2');
    const facts = { a: a.ok, b: b.ok, both, afterSweep, bNextWelcome: bAgain.ok ? 'paid' : bAgain.why };
    console.log('  FACTS sm9-faucet-2:', JSON.stringify(facts));
    // 1.9 (#2473, #2505): an invoice whose hash a row already holds is refused before booking - one hash, one row - so B's ask on A's invoice
    // books nothing; no row of B is ever booked final on a payment that is not
    assert.equal(b.ok, false, 'a second account\'s welcome on an invoice already booked is refused');
    assert.ok(!both.some((x) => x.startsWith('b2:')), `B's welcome on the same invoice was booked: ${JSON.stringify(both)}`);
    assert.deepEqual(both, ['a1:pending'], `A's welcome in flight is not pending: ${JSON.stringify(both)}`);
    assert.deepEqual(afterSweep, [], 'A\'s FAILED payment leaves no row');
    assert.equal(bAgain.ok, true, `B was never paid (its payment FAILED) yet is refused its welcome: ${bAgain.why}`);
  } finally { child.kill(); }
});
