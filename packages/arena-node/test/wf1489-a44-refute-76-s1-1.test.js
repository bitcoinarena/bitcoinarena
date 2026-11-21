// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-76-1 (refutes #1784 "settle asks only the payer that made a payment"): the payer is keyed by NETWORK only. The bounty wallet is
// replaced on the SAME network (a new lnd, a node restored from seed, FAUCET_BOUNTY_PAYER pointed at another dir) while a mainnet reward is paying
// (old wallet: IN_FLIGHT). After the restart settle asks the NEW wallet's trackpayment, which answers "payment isn't initiated" (NONE) - bountyStatus
// reads NONE as failed, the link opens again and the holder is paid a second time from the new wallet. A reward is paid at most once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
const fs_mk = (d) => { mkdirSync(join(d, 'old'), { recursive: true }); mkdirSync(join(d, 'new'), { recursive: true }); };
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
const readLines = (f) => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

test('#1489 a44-refute-76-1: a reward paying from the old bounty wallet is not reopened and paid again after the wallet is replaced on the same network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-76-1-'));
  // ONE STAND-IN lncli FOR BOTH WALLETS, by --lnddir (both mainnet): the old wallet's payment stays in flight; the new wallet never saw it
  // (trackpayment: "payment isn't initiated", as lnd answers) and pays whatever it is asked to
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), dirArg = (a.find((x) => x.startsWith('--lnddir=')) || '').slice(9), last = a[a.length - 1];
const wallet = dirArg.endsWith('/new') ? 'new' : 'old';
const h = require('crypto').createHash('sha256').update(last).digest('hex');
const sentLog = ${JSON.stringify(join(dir, 'old-sent.log'))};
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: (/^ln(?:tb|bc)(\\d+)x/.exec(last) || [])[1] || '0', payment_hash: h })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (wallet === 'old') { fs.appendFileSync(sentLog, last + '\\n'); console.log('Payment hash: ' + h); console.log('Payment status: IN_FLIGHT'); process.exit(0); }
  fs.appendFileSync(${JSON.stringify(join(dir, 'new-paid.log'))}, last + '\\n'); console.log('Payment hash: ' + h); console.log('Payment status: SUCCEEDED'); process.exit(0);
}
if (a.includes('trackpayment')) {
  if (wallet === 'old') { console.log('Payment status: IN_FLIGHT'); process.exit(0); }
  console.error('[lncli] rpc error: code = NotFound desc = payment isn\\'t initiated'); process.exit(1);
}
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
process.exit(1);
`);
  fs_mk(dir);
  chmodSync(lncli, 0o755);
  // the restart comes 200 s later (the faucet's own clock), and settle's minute timer is shortened so the test needs no real minutes
  const clock = join(dir, 'clock.mjs');
  writeFileSync(clock, `const off = Number(process.env.T_CLOCK_OFFSET_MS || 0); const real = Date.now; Date.now = () => real() + off;
const si = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 ? 300 : ms, ...a);
`);
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const db = join(dir, 'feedback.db');
  const start = (network, offsetMs, wallet) => {
    const port = 20000 + Math.floor(Math.random() * 9000);
    const p = spawn(process.execPath, ['--import', clock, fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, T_CLOCK_OFFSET_MS: String(offsetMs), FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6',
        FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
        FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${join(dir, wallet)}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE,
        FAUCET_BOUNTY_NETWORK: network } });
    let log = ''; p.stdout.on('data', (c) => { log += c; }); p.stderr.on('data', (c) => { log += c; });
    return { p, base: `http://127.0.0.1:${port}`, log: () => log };
  };
  const up = async (f) => { for (let i = 0; i < 80; i++) { try { await fetch(`${f.base}/feedback/rewards`); return; } catch { await sleep(100); } } throw new Error(`faucet did not start: ${f.log()}`); };
  const stop = async (f) => { f.p.kill('SIGKILL'); await new Promise((r) => (f.p.exitCode !== null ? r() : f.p.once('exit', r))); };
  let f = null;
  try {
    // RUN 1, mainnet, old wallet: a report, approved, its link made, the holder's wallet calls back - in flight
    f = start('mainnet', 0, 'old'); await up(f);
    const alice = key(3);
    const ev = signed(alice, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The deposit button stays grey after the wallet shows a full balance of sats' }));
    await (await fetch(`${f.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    let admin = openFeedbackStore(db);
    assert.equal(admin.approve(ev.id, 2000, { played: () => true, by: 'admin' }).ok, true);
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1;
    admin.close();
    const first = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'a'.repeat(40)}`)).json();
    admin = openFeedbackStore(db); const afterRun1 = admin.reward(k1).state; admin.close();
    await stop(f);
    // RUN 2, mainnet, 200 s later, the bounty wallet replaced: settle reads the paying reward from the new wallet
    f = start('mainnet', 200000, 'new'); await up(f);
    await sleep(2500);
    admin = openFeedbackStore(db); const afterSettle = admin.reward(k1).state; admin.close();
    const second = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'b'.repeat(40)}`)).json();
    admin = openFeedbackStore(db); const finalState = admin.reward(k1).state; admin.close();
    const facts = { first: first.status, afterRun1, afterSettle, second: second.status, finalState, testnetSent: readLines(join(dir, 'old-sent.log')).length, mainnetPaid: readLines(join(dir, 'new-paid.log')).length };
    console.log('  FACTS a44-refute-76-1:', JSON.stringify(facts));
    assert.equal(facts.afterRun1, 'paying', 'run 1: the unsettled payment leaves the link paying');
    assert.equal(facts.testnetSent, 1);
    assert.notEqual(facts.afterSettle, 'open', 'a payment the old wallet sent is not read as failed by the new wallet');
    assert.equal(facts.testnetSent + facts.mainnetPaid, 1, 'the reward is paid once, not once per wallet');
  } finally { if (f) await stop(f).catch(() => {}); chat.close(); }
});
