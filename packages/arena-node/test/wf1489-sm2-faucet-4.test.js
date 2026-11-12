// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-faucet-4 (SM-22, the reward link's `paying` state): a withdraw callback whose payment outcome is not known at once stays
// `paying` for settle() to read. settle's bountyStatus reads `lncli listpayments --include_incomplete --max_payments=500` through execFile with
// node's default 1 MB maxBuffer. lncli prints each payment with its HTLCs and route hops, about 3 KB a payment, so once the bounty wallet holds a
// few hundred payments every read overflows, the read counts as 'unknown' and the reward stays `paying` for good - although it was paid: the
// player is never shown paid, the report never becomes paid, and the admin cannot reject or reopen it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const PRIVATE = 'https://arena-fb-private.example';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// one payment as lnd's listpayments prints it: one settled HTLC over three hops
const payment = (i, hash, status) => {
  const hop = (j) => ({ chan_id: String(900000000000000 + i * 10 + j), chan_capacity: '5000000', amt_to_forward: '2000', fee: '1', expiry: 880000 + j, amt_to_forward_msat: '2000000',
    fee_msat: '1000', pub_key: `02${createHash('sha256').update(`hop${i}-${j}`).digest('hex')}`, tlv_payload: true, mpp_record: { payment_addr: createHash('sha256').update(`a${i}`).digest('base64'), total_amt_msat: '2000000' },
    amp_record: null, custom_records: {}, metadata: '', blinding_point: '', encrypted_data: '', total_amt_msat: '0' });
  return { payment_hash: hash, value: '2000', creation_date: String(1762000000 + i), fee: '2', payment_preimage: createHash('sha256').update(`p${i}`).digest('hex'), value_sat: '2000', value_msat: '2000000',
    payment_request: `lnbc20u1p${createHash('sha512').update(`r${i}`).digest('hex')}${createHash('sha512').update(`s${i}`).digest('hex')}${createHash('sha512').update(`t${i}`).digest('hex')}`,
    status, fee_sat: '2', fee_msat: '2000', creation_time_ns: String(1762000000000000000 + i),
    htlcs: [{ attempt_id: String(i * 3), status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'IN_FLIGHT', route: { total_time_lock: 880100, total_fees: '2', total_amt: '2002', hops: [hop(0), hop(1), hop(2)],
      total_fees_msat: '2000', total_amt_msat: '2002000', first_hop_amount_msat: '2002000', custom_channel_data: '' }, attempt_time_ns: String(1762000000000000000 + i), resolve_time_ns: String(1762000000500000000 + i),
      failure: null, preimage: createHash('sha256').update(`p${i}`).digest('hex'), attempt_id_: undefined }], payment_index: String(i + 1), failure_reason: 'FAILURE_REASON_NONE', first_hop_custom_records: {} };
};

async function scenario(count) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-4-'));
  // the bounty wallet's earlier payments (350, fewer than the 500 asked for), written once; the claim's own payment is added as the newest
  const older = []; for (let i = 0; i < count; i++) older.push(payment(i, createHash('sha256').update(`old${i}`).digest('hex'), 'SUCCEEDED'));
  writeFileSync(join(dir, 'older.json'), JSON.stringify(older));
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), last = a[a.length - 1];
const h = require('crypto').createHash('sha256').update(last).digest('hex');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: (/^ln(?:tb|bc)(\\d+)x/.exec(last) || [])[1] || '0', payment_hash: h })); process.exit(0); }
if (a.includes('payinvoice')) { fs.writeFileSync(${JSON.stringify(join(dir, 'ours.txt'))}, h); console.log('Payment hash: ' + h); console.log('Payment status: IN_FLIGHT'); process.exit(0); }
if (a.includes('listpayments')) {
  const older = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'older.json'))}, 'utf8'));
  const ours = fs.existsSync(${JSON.stringify(join(dir, 'ours.txt'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'ours.txt'))}, 'utf8') : null;
  if (ours) { const p = JSON.parse(JSON.stringify(older[0])); p.payment_hash = ours; p.status = 'SUCCEEDED'; p.payment_index = String(older.length + 1); older.push(p); }
  const out = JSON.stringify({ payments: older, first_index_offset: '1', last_index_offset: String(older.length), total_num_payments: '0' }, null, 4);
  fs.writeFileSync(${JSON.stringify(join(dir, 'listpayments-bytes.txt'))}, String(Buffer.byteLength(out)));
  // no process.exit after a big write: on a pipe (macOS) it would cut the output short; the process ends when stdout is drained
  process.stdout.write(out + '\\n');
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
    const bob = key(4);
    const ev = signed(bob, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The round list shows a finished round as open until the page is reloaded twice' }));
    await (await fetch(`${f.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    let admin = openFeedbackStore(db);
    assert.equal(admin.approve(ev.id, 2000, { played: () => true, by: 'admin' }).ok, true);
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1;
    admin.close();
    const first = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'c'.repeat(40)}`)).json();
    await stop(f);
    // the same faucet 200 s later (or simply 3 minutes on): settle reads the payment, which SUCCEEDED
    f = start(200000); await up(f);
    await sleep(3000);
    admin = openFeedbackStore(db);
    const facts = { first: first.status, reward: admin.reward(k1).state, report: admin.report(ev.id).state, payments: count + 1, listBytes: Number((await import('node:fs')).readFileSync(join(dir, 'listpayments-bytes.txt'), 'utf8')) };
    admin.close();
    console.log('  FACTS sm2-faucet-4:', JSON.stringify(facts));
    return facts;
  } finally { if (f) await stop(f).catch(() => {}); chat.close(); }
}

test('#1489 sm2-faucet-4: a paid reward left paying is read as paid by settle when the bounty wallet holds a few hundred payments', async () => {
  // the control: with 20 earlier payments settle reads the payment and books it paid
  const few = await scenario(20);
  assert.equal(few.reward, 'paid', 'control: 21 payments listed, the reward is read as paid');
  // 350 earlier payments (fewer than the 500 listpayments is asked for): the same SUCCEEDED payment must be read the same way
  const many = await scenario(350);
  assert.equal(many.first, 'ERROR');
  assert.equal(many.reward, 'paid', 'a SUCCEEDED payment the wallet lists is read as paid');
  assert.equal(many.report, 'paid');
});
