// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-73 skeptic 2 (fix #1785, SM-22): bountyStatus now asks `lncli trackpayment <hash>` first and reads its TABLE output
// (paymentFinal). lncli 0.21 prints each HTLC's ROUTE as the hops' node ALIASES (cmd_payments.go formatPayment: aliases.get -> GetNodeInfo alias,
// joined "->"). A node alias is chosen by its operator: the reporter's own receiving node, or any routing node on an attempted route. paymentFinal
// tests /isn't initiated|not initiated|not found|unknown payment/ on the whole text BEFORE it reads "Payment status:", so a node aliased "not found"
// turns a SUCCEEDED (or still in flight, held) payment into NONE -> 'failed' -> settle reopens the link -> the reporter claims it again: paid twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const PRIVATE = 'https://arena-fb-private.example';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// mode 'paid': the first payment SUCCEEDED, its route ends at the reporter's node aliased `alias`
// mode 'held': the first payment is IN_FLIGHT (a hold invoice), trackpayment streams its table and never ends (killed at 10 s)
async function scenario({ alias, mode }) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-73-s2-'));
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), last = a[a.length - 1], D = ${JSON.stringify(dir)};
const h = require('crypto').createHash('sha256').update(last).digest('hex');
const pays = () => { try { return JSON.parse(fs.readFileSync(D + '/pays.json', 'utf8')); } catch { return []; } };
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: (/^ln(?:tb|bc)(\\d+)x/.exec(last) || [])[1] || '0', payment_hash: h })); process.exit(0); }
if (a.includes('payinvoice')) {
  const p = pays(); p.push(h); fs.writeFileSync(D + '/pays.json', JSON.stringify(p));
  console.log('Payment hash: ' + h);
  // the first payment: outcome not known at once (timeout / hold); a later one settles at once
  console.log(p.length === 1 ? 'Payment status: IN_FLIGHT' : 'Payment status: SUCCEEDED, preimage: ' + '11'.repeat(32)); process.exit(0);
}
if (a.includes('trackpayment')) {
  if (!pays().includes(last)) { console.error('[lncli] rpc error: code = Unknown desc = payment isn\\'t initiated'); process.exit(1); }
  const st = ${JSON.stringify(mode)} === 'held' ? 'IN_FLIGHT' : 'SUCCEEDED';
  const route = 'ACINQ->' + ${JSON.stringify(alias)};
  const w = Math.max(5, route.length);
  const line = '+------------+--------------+--------------+--------------+-----+----------+--------------------+-' + '-'.repeat(w) + '-+';
  process.stdout.write(line + '\\n| HTLC_STATE | ATTEMPT_TIME | RESOLVE_TIME | RECEIVER_AMT | FEE | TIMELOCK | CHAN_OUT           | ' + 'ROUTE'.padEnd(w) + ' |\\n' + line + '\\n'
    + '| ' + st.padEnd(10) + ' |        0.012 |        ' + (st === 'SUCCEEDED' ? '1.734' : '    -') + ' | 2000         | 1   |   880144 | 912345678901234567 | ' + route.padEnd(w) + ' |\\n' + line + '\\n'
    + 'Amount + fee:   ' + (st === 'SUCCEEDED' ? '2000 + 1' : '0 + 0') + ' sat\\nPayment hash:   ' + last + '\\nPayment status: ' + st + (st === 'SUCCEEDED' ? ', preimage: ' + '11'.repeat(32) : '') + '\\n');
  if (st === 'IN_FLIGHT') setTimeout(() => {}, 600000);   // lncli waits for a final state; the faucet kills it after 10 s
} else process.exit(1);
`);
  chmodSync(lncli, 0o755);
  const clock = join(dir, 'clock.mjs');
  writeFileSync(clock, `const off = Number(process.env.T_CLOCK_OFFSET_MS || 0); const real = Date.now; Date.now = () => real() + off;
const si = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 ? 300 : ms, ...a);
`);
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const db = join(dir, 'feedback.db');
  const start = (offsetMs) => {
    const port = 20000 + Math.floor(Math.random() * 9000);
    const p = spawn(process.execPath, ['--import', clock, fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, T_CLOCK_OFFSET_MS: String(offsetMs), FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6',
        FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
        FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE,
        FAUCET_BOUNTY_NETWORK: 'mainnet' } });
    let log = ''; p.stdout.on('data', (c) => { log += c; }); p.stderr.on('data', (c) => { log += c; });
    return { p, base: `http://127.0.0.1:${port}`, log: () => log };
  };
  const up = async (f) => { for (let i = 0; i < 80; i++) { try { await fetch(`${f.base}/feedback/rewards`); return; } catch { await sleep(100); } } throw new Error(`faucet did not start: ${f.log()}`); };
  const stop = async (f) => { f.p.kill('SIGKILL'); await new Promise((r) => (f.p.exitCode !== null ? r() : f.p.once('exit', r))); };
  let f = null;
  try {
    f = start(0); await up(f);
    const bob = key(5);
    const ev = signed(bob, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The lobby keeps a finished round listed as open until the page is reloaded' }));
    await (await fetch(`${f.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    let admin = openFeedbackStore(db);
    assert.equal(admin.approve(ev.id, 2000, { played: () => true, by: 'admin' }).ok, true);
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1;
    admin.close();
    const first = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'c'.repeat(40)}`)).json();
    await stop(f);
    // 200 s later: settle reads the first payment by its hash (trackpayment)
    f = start(200000); await up(f);
    await sleep(mode === 'held' ? 13000 : 3000);
    admin = openFeedbackStore(db);
    const afterSettle = admin.reward(k1).state;
    admin.close();
    // the reporter tries the same link again with a fresh invoice
    const second = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'d'.repeat(40)}`)).json();
    const payments = existsSync(join(dir, 'pays.json')) ? JSON.parse(readFileSync(join(dir, 'pays.json'), 'utf8')).length : 0;
    const facts = { alias, mode, first: first.status, afterSettle, second: second.status, payinvoiceCalls: payments };
    console.log('  FACTS a44-refute-73-s2:', JSON.stringify(facts));
    return facts;
  } finally { if (f) await stop(f).catch(() => {}); chat.close(); }
}

test('#1489 a44-refute-73-s2: control - a SUCCEEDED payment through an ordinary alias is booked paid', async () => {
  const c = await scenario({ alias: 'bobs-node', mode: 'paid' });
  assert.equal(c.afterSettle, 'paid');
  assert.equal(c.payinvoiceCalls, 1);
});

test('#1489 a44-refute-73-s2: a SUCCEEDED reward whose route names a node aliased "not found" is not reopened and paid twice', async () => {
  const r = await scenario({ alias: 'not found', mode: 'paid' });
  assert.equal(r.afterSettle, 'paid', 'the payment SUCCEEDED: settle must book it paid, not reopen the link');
  assert.equal(r.payinvoiceCalls, 1, 'the reward was paid twice');
});

test('#1489 a44-refute-73-s2: a held (IN_FLIGHT) reward whose route names a node aliased "unknown payment" stays paying', async () => {
  const r = await scenario({ alias: 'unknown payment', mode: 'held' });
  assert.equal(r.afterSettle, 'paying', 'a payment still in flight must stay paying; reopening it lets the holder claim again and release both');
  assert.equal(r.payinvoiceCalls, 1, 'a second payment was sent while the first was still held');
});
