// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-faucet-3 (SM-22, the reward link, across a restart that changes the payout network - as on 2026-11-11, testnet4 -> mainnet):
// a reward whose withdraw callback paid on the testnet4 bounty wallet with an outcome not known yet stays `paying`. The faucet is restarted with
// FAUCET_BOUNTY_NETWORK=mainnet. settle() asks the NEW (mainnet) wallet's listpayments for that payment hash; that wallet never saw it, and "not in
// the list" reads as failed - the link is reopened and the holder is paid a second time, now in mainnet sats. A reward is paid at most once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
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

test('#1489 sm2-faucet-3: a reward whose testnet4 payment is still unsettled is not reopened and paid again after the switch to mainnet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-3-'));
  // ONE STAND-IN lncli FOR BOTH WALLETS, by --network: the testnet4 wallet's payment stays in flight (it settles later, on testnet4); the mainnet
  // wallet never saw it (its listpayments is empty) and pays whatever it is asked to
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), net = (a.find((x) => x.startsWith('--network=')) || '').slice(10), last = a[a.length - 1];
const h = require('crypto').createHash('sha256').update(last).digest('hex');
fs.appendFileSync(${JSON.stringify(join(dir, 'args.log'))}, a.join(' ') + '\\n');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: (/^ln(?:tb|bc)(\\d+)x/.exec(last) || [])[1] || '0', payment_hash: h })); process.exit(0); }
if (a.includes('payinvoice')) {
  if (net === 'testnet4') { fs.appendFileSync(${JSON.stringify(join(dir, 'testnet-sent.log'))}, last + '\\n'); console.log('Payment hash: ' + h); console.log('Payment status: IN_FLIGHT'); process.exit(0); }
  fs.appendFileSync(${JSON.stringify(join(dir, 'mainnet-paid.log'))}, last + '\\n'); console.log('Payment hash: ' + h); console.log('Payment status: SUCCEEDED'); process.exit(0);
}
if (a.includes('listpayments')) {
  if (net === 'testnet4') { const sent = (fs.existsSync(${JSON.stringify(join(dir, 'testnet-sent.log'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'testnet-sent.log'))}, 'utf8') : '').trim().split('\\n').filter(Boolean);
    console.log(JSON.stringify({ payments: sent.map((i) => ({ payment_hash: require('crypto').createHash('sha256').update(i).digest('hex'), status: 'IN_FLIGHT' })) })); process.exit(0); }
  console.log(JSON.stringify({ payments: [] })); process.exit(0);
}
process.exit(1);
`);
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
  const start = (network, offsetMs) => {
    const port = 20000 + Math.floor(Math.random() * 9000);
    const p = spawn(process.execPath, ['--import', clock, fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, T_CLOCK_OFFSET_MS: String(offsetMs), FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6',
        FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
        FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE,
        FAUCET_BOUNTY_NETWORK: network } });
    let log = ''; p.stdout.on('data', (c) => { log += c; }); p.stderr.on('data', (c) => { log += c; });
    return { p, base: `http://127.0.0.1:${port}`, log: () => log };
  };
  const up = async (f) => { for (let i = 0; i < 80; i++) { try { await fetch(`${f.base}/feedback/rewards`); return; } catch { await sleep(100); } } throw new Error(`faucet did not start: ${f.log()}`); };
  const stop = async (f) => { f.p.kill('SIGKILL'); await new Promise((r) => (f.p.exitCode !== null ? r() : f.p.once('exit', r))); };
  let f = null;
  try {
    // RUN 1, testnet4: a report, approved, its link made (testnet4), the holder's wallet calls back with a testnet invoice - in flight
    f = start('testnet4', 0); await up(f);
    const alice = key(3);
    const ev = signed(alice, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The deposit button stays grey after the wallet shows a full balance of sats' }));
    await (await fetch(`${f.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    let admin = openFeedbackStore(db);
    assert.equal(admin.approve(ev.id, 2000, { played: () => true, by: 'admin' }).ok, true);
    const k1 = admin.createReward(ev.id, { network: 'testnet4' }).reward.k1;
    admin.close();
    const first = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lntb2000x1${'a'.repeat(40)}`)).json();
    admin = openFeedbackStore(db); const afterRun1 = admin.reward(k1).state; admin.close();
    await stop(f);
    // RUN 2, mainnet, 200 s later: settle reads the paying reward from the mainnet wallet
    f = start('mainnet', 200000); await up(f);
    await sleep(2500);
    admin = openFeedbackStore(db); const afterSettle = admin.reward(k1).state; admin.close();
    const second = await (await fetch(`${f.base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2000x1${'b'.repeat(40)}`)).json();
    admin = openFeedbackStore(db); const finalState = admin.reward(k1).state; admin.close();
    const facts = { first: first.status, afterRun1, afterSettle, second: second.status, finalState, testnetSent: readLines(join(dir, 'testnet-sent.log')).length, mainnetPaid: readLines(join(dir, 'mainnet-paid.log')).length };
    console.log('  FACTS sm2-faucet-3:', JSON.stringify(facts));
    assert.equal(facts.afterRun1, 'paying', 'run 1: the unsettled testnet payment leaves the link paying');
    assert.equal(facts.testnetSent, 1);
    assert.notEqual(facts.afterSettle, 'open', 'a payment the testnet4 wallet sent is not read as failed by the mainnet wallet');
    assert.equal(facts.testnetSent + facts.mainnetPaid, 1, 'the reward is paid once, not once on testnet4 and again on mainnet');
  } finally { if (f) await stop(f).catch(() => {}); chat.close(); }
});
