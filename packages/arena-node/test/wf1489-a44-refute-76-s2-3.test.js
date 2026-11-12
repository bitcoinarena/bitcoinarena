// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-76-s2-3 (resume path of #2177): a row that went to 'paying' before the payer column existed (every reward paying on the live
// 90d57151a faucet when 704b7f257 is deployed) has payer NULL, and settle reads a NULL payer "as before" - it asks whatever wallet runs now. Deployed
// together with a bounty wallet change on the same network (the deploy that brings the payer column is the moment wallets get rotated), the new wallet
// answers "payment isn't initiated", the link opens and the holder is paid by both wallets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, openFeedbackStore } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const PRIVATE = 'https://arena-fb-private.example';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const readLines = (f) => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const NODE_KEY = '02' + 'ab'.repeat(32);

// ONE STAND-IN lncli. Its behaviour is the file <lnddir>/mode, written by the test between the runs:
//   inflight  - payinvoice leaves the payment IN_FLIGHT, trackpayment IN_FLIGHT, getinfo answers NODE_KEY
//   restored  - the same node (same key, same lnddir) restored from seed / with a fresh payment db: trackpayment "payment isn't initiated", payinvoice pays
//   nokey     - getinfo fails (wallet busy / rpc timeout), payinvoice IN_FLIGHT
//   succeeded - getinfo answers NODE_KEY, trackpayment SUCCEEDED (the same wallet, the payment went through)
function harness(dir) {
  mkdirSync(join(dir, 'w'), { recursive: true }); mkdirSync(join(dir, 'new'), { recursive: true });
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!${process.execPath}
const fs = require('fs'), path = require('path'), a = process.argv.slice(2), d = (a.find((x) => x.startsWith('--lnddir=')) || '').slice(9), last = a[a.length - 1];
let mode = 'restored'; try { mode = fs.readFileSync(path.join(d, 'mode'), 'utf8').trim(); } catch {}
const h = require('crypto').createHash('sha256').update(last).digest('hex');
const log = (n) => fs.appendFileSync(path.join(${JSON.stringify(dir)}, n), last + '\\n');
if (a.includes('getinfo')) { if (mode === 'nokey') { console.error('rpc error: deadline exceeded'); process.exit(1); } console.log(JSON.stringify({ identity_pubkey: ${JSON.stringify(NODE_KEY)} })); process.exit(0); }
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: (/^ln(?:tb|bc)(\\d+)x/.exec(last) || [])[1] || '0', payment_hash: h })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (mode === 'restored') { log('paid-again.log'); console.log('Payment hash: ' + h); console.log('Payment status: SUCCEEDED'); process.exit(0); }
  log('sent.log'); console.log('Payment hash: ' + h); console.log('Payment status: IN_FLIGHT'); process.exit(0);
}
if (a.includes('trackpayment')) {
  if (mode === 'restored') { console.error("[lncli] rpc error: code = NotFound desc = payment isn't initiated"); process.exit(1); }
  if (mode === 'succeeded') { console.log('Payment status: SUCCEEDED'); process.exit(0); }
  console.log('Payment status: IN_FLIGHT'); process.exit(0);
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
process.exit(1);
`);
  chmodSync(lncli, 0o755);
  const clock = join(dir, 'clock.mjs');
  writeFileSync(clock, `const off = Number(process.env.T_CLOCK_OFFSET_MS || 0); const real = Date.now; Date.now = () => real() + off;
const si = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 ? 300 : ms, ...a);
`);
  writeFileSync(join(dir, 'token'), 'x');
  return { lncli, clock };
}

async function scenario(dir) {
  const { lncli, clock } = harness(dir);
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const db = join(dir, 'feedback.db');
  const start = (offsetMs, wallet) => {
    const port = 20000 + Math.floor(Math.random() * 9000);
    const p = spawn(process.execPath, ['--import', clock, fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, T_CLOCK_OFFSET_MS: String(offsetMs), FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6',
        FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
        FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${join(dir, wallet)}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE,
        FAUCET_BOUNTY_NETWORK: 'mainnet' } });
    let log = ''; p.stdout.on('data', (c) => { log += c; }); p.stderr.on('data', (c) => { log += c; });
    return { p, base: `http://127.0.0.1:${port}`, log: () => log };
  };
  const up = async (f) => { for (let i = 0; i < 80; i++) { try { await fetch(`${f.base}/feedback/rewards`); return; } catch { await sleep(100); } } throw new Error(`faucet did not start: ${f.log()}`); };
  const stop = async (f) => { f.p.kill('SIGKILL'); await new Promise((r) => (f.p.exitCode !== null ? r() : f.p.once('exit', r))); };
  const report = async (f, n) => {
    const who = key(n);
    const ev = signed(who, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The deposit button stays grey after the wallet shows a full balance of sats ' + n }));
    await (await fetch(`${f.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const admin = openFeedbackStore(db);
    assert.equal(admin.approve(ev.id, 2000, { played: () => true, by: 'admin' }).ok, true);
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1; admin.close();
    return k1;
  };
  const claim = async (f, k1, c) => (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${c.repeat(40)}`)).json();
  const reward = (k1) => { const s = openFeedbackStore(db); const r = s.reward(k1); s.close(); return r; };
  const mode = (wallet, m) => writeFileSync(join(dir, wallet, 'mode'), m);
  return { start, up, stop, report, claim, reward, mode, db, done: () => chat.close() };
}

test('#1489 a44-refute-76-s2-3: a reward paying from before the payer column is not reopened when the faucet comes back on another wallet', async () => {
  const s = await scenario(mkdtempSync(join(tmpdir(), 'wf1489-a44-76-s2-3-')));
  let f = null;
  try {
    s.mode('w', 'inflight'); s.mode('new', 'restored');
    f = s.start(0, 'w'); await s.up(f);
    const k1 = await s.report(f, 5);
    await s.stop(f);
    // the claim made by the faucet before the upgrade: the same store, no payer (as 90d57151a wrote it)
    const old = openFeedbackStore(s.db);
    const lncliPay = async () => ({ ok: false, why: 'in flight' });
    const first = await old.claim(k1, 'lnbc2000x1' + 'e'.repeat(40), { decode: async () => ({ ok: true, amountSats: 2000, paymentHash: 'ee'.repeat(32) }), pay: async (i) => { writeFileSync(join(s.db, '..', 'sent.log'), i + '\n'); return lncliPay(); }, network: 'mainnet', nowMs: Date.now() });
    old.close();
    const afterRun1 = s.reward(k1);
    f = s.start(200000, 'new'); await s.up(f);
    await sleep(2500);
    const afterSettle = s.reward(k1).state;
    const second = await s.claim(f, k1, 'f');
    const facts = { first: first.status, afterRun1: afterRun1.state, payer: afterRun1.payer, afterSettle, second: second.status,
      sent: readLines(join(s.db, '..', 'sent.log')).length, paidAgain: readLines(join(s.db, '..', 'paid-again.log')).length };
    console.log('  FACTS a44-refute-76-s2-3:', JSON.stringify(facts));
    assert.equal(facts.afterRun1, 'paying');
    assert.equal(facts.payer, null);
    assert.notEqual(facts.afterSettle, 'open', 'a reward paying from before the payer column is not reopened on another wallet\'s word');
    assert.equal(facts.sent + facts.paidAgain, 1, 'the reward is paid once');
  } finally { if (f) await s.stop(f).catch(() => {}); s.done(); }
});
