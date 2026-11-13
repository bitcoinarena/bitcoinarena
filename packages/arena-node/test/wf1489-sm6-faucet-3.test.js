// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm6-faucet-3 (state machine audit, round 6): a bounty's LNURL-withdraw callback (and the admin's pay-to-address) runs claim() in the
// PLAYERS' queue one() - its payinvoice may run 75 s (lncli's timeout), a pay-to-address 20 s more for the address's two fetches and the decode.
// Every welcome asked meanwhile waits behind it, past the page's 45 s: the page gives up and the queued welcome is then dropped ("the page stopped
// waiting", #1419) - the same hold #1419 took the admin's approve out of the queue for. A reward claim and a welcome share no state.
// The real tools/faucet.mjs against a fake lncli: the bounty payer's payinvoice hangs, the faucet payer pays at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const hex = (b) => Buffer.from(b).toString('hex');

test('#1489 sm6-faucet-3: a welcome is not held behind a bounty payment that is still going', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm6-faucet-3-'));
  // an approved report with its reward link, in the store the faucet opens
  const secret = new Uint8Array(32).fill(9), pubkey = hex(schnorr.getPublicKey(secret));
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: 'The withdraw button did nothing. Steps: opened the lobby, joined a round, watched the screen.', expected: 'it to work' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  const s = openFeedbackStore(join(dir, 'fb.db'));
  s.take(e); assert.equal(s.approve(e.id, 2000, { played: () => true }).ok, true);
  const k1 = s.createReward(e.id, { network: 'testnet4' }).reward.k1; s.close();
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), rpc = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12), inv = a[a.length - 1];
if (a.includes('decodepayreq')) { const b = /bbbbbbbb/.test(inv); console.log(JSON.stringify({ num_satoshis: b ? '2000' : '3000', payment_hash: (b ? 'b1' : 'a1').repeat(32), destination: 'x' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + rpc })); process.exit(0); }
if (a.includes('payinvoice')) { if (rpc === '127.0.0.1:2') { setTimeout(() => process.exit(1), 90000); return; } console.log('Payment status: SUCCEEDED'); process.exit(0); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
if (a.includes('trackpayment')) { console.log('Payment status: SUCCEEDED'); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'),
    FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:2`, FAUCET_BOUNTY_NETWORK: 'testnet4', FAUCET_BOUNTY_ORIGINS: 'https://testnet-stage.bitcoinarena.io',
    FAUCET_SWEEP_MS: '600000' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    // the reporter's wallet claims the reward: its payment goes on (a slow route, a held HTLC)
    const claim = fetch(`http://127.0.0.1:${port}/lnurlw/${k1}/callback?k1=${k1}&pr=lntb20u1p${'b'.repeat(40)}`).then((r) => r.json(), () => null);
    await new Promise((ok) => setTimeout(ok, 1500));
    // a new player's welcome, asked meanwhile; the page waits 45 s (askFaucet), here 8 s
    const t0 = Date.now();
    let welcome;
    try { welcome = await (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ kind: 'welcome', account: 'cd'.repeat(32), invoice: `lntb30u1p${'q'.repeat(40)}` }) })).json(); } catch (x) { welcome = { gaveUp: String(x.name) }; }
    console.log('  MEASURED sm6-faucet-3:', JSON.stringify({ welcome, ms: Date.now() - t0 }));
    void claim;
    assert.equal(welcome.ok, true, `the welcome waited behind the bounty payment and was not answered (${JSON.stringify(welcome)})`);
  } finally { child.kill(); }
});
