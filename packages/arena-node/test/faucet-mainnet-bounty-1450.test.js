// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1450 (Daniel 2026-11-11: "echte lightning payments auf mainnet als bounties"), through the faucet itself; based on #1342's harness: tools/faucet.mjs run as a process with a store in a temp folder and a stand-in for Arena Chat.
// An unsigned report goes to the chat as before and is not kept; a signed one goes to the chat and is kept; a forged one goes nowhere;
// GET /feedback/mine answers the reporter's NIP-98 sign-in for the configured URL and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, HTTP_AUTH_KIND } from '../src/feedback-store.js';
import { ownerStatementMessage } from '../src/owner.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const MINE = 'https://testnet.example/api/faucet/feedback/mine';
const PRIVATE = 'https://arena-fb-private.example';

test('#1450 bounties paid on mainnet: the bounty wallet is asked with --network=mainnet, an lnbc invoice is paid once, a testnet lntb invoice is refused; the routing fee may be 1 % of the reward', async () => {
  const { chmodSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'faucet-mainnet-1450-'));
  // A STAND-IN lncli: decodepayreq reads the amount from the invoice's text, payinvoice succeeds once per invoice and logs it
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!/bin/bash
cmd=""; for a in "$@"; do case "$a" in decodepayreq|payinvoice|listpayments) cmd="$a";; esac; done
echo "$*" >> "${join(dir, 'args.log')}"
inv="\${@: -1}"
case "$cmd" in
  decodepayreq) sats=$(echo "$inv" | sed -E 's/^ln(tb|bc)([0-9]+)x.*/\\2/'); echo "{\\"num_satoshis\\":\\"$sats\\",\\"payment_hash\\":\\"$(echo -n "$inv" | sha256sum | cut -c1-64)\\"}";;
  payinvoice) echo "$inv" >> "${join(dir, 'paid.log')}"; echo "Payment hash: $(echo -n "$inv" | sha256sum | cut -c1-64)"; echo "Payment status: SUCCEEDED";;
  listpayments) echo '{"payments":[]}';;
esac
`);
  chmodSync(lncli, 0o755);
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE, FAUCET_BOUNTY_NETWORK: 'mainnet' } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const alice = key(1);
    const ev = signed(alice, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The withdraw spinner never stops, even after waiting five minutes' }));
    await (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    // the admin approves it and makes the link (slice 4's buttons), on the same file
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    const admin = openFeedbackStore(db);
    admin.approve(ev.id, 2500, { played: () => true, by: 'admin' });
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1;
    admin.close();
    const mineNow = async (origin = PRIVATE) => (await fetch(`${base}/feedback/mine`, { headers: { origin, authorization: `Nostr ${Buffer.from(JSON.stringify(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]))).toString('base64')}` } })).json();
    const before = await mineNow();
    const req = await (await fetch(`${base}/lnurlw/${k1}`)).json();
    const cb = (pr, k = k1) => fetch(`${base}/lnurlw/${k1}/callback?k1=${k}&pr=${pr}`).then((r) => r.json());
    const testnetInvoice = await cb('lntb2500x1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const [one, two] = await Promise.all([cb('lnbc2500x1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), cb('lnbc2500x1ccccccccccccccccccccccccccccccc')]);
    const after = await mineNow();
    const publicView = await mineNow('https://testnet.bitcoinarena.io');
    const reqAfter = await (await fetch(`${base}/lnurlw/${k1}`)).json();
    let paidLines = []; try { paidLines = readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n'); } catch { paidLines = []; }
    const args = readFileSync(join(dir, 'args.log'), 'utf8').trim().split('\n');
    const facts = { testnet: testnetInvoice.status, claims: [one.status, two.status], paid: paidLines, networks: [...new Set(args.map((a) => (/--network=(\S+)/.exec(a) || [])[1]))],
      feeLimit: (args.find((a) => /payinvoice/.test(a)) || '').match(/--fee_limit=(\d+)/)?.[1], after: after.reports.map((r) => [r.state, r.reward && r.reward.state, r.reward && r.reward.network]) };
    console.log('  FACTS #1450 mainnet:', JSON.stringify(facts));
    assert.equal(facts.testnet, 'ERROR', 'a testnet invoice is not paid from the mainnet bounty wallet');
    assert.deepEqual(facts.claims.sort(), ['ERROR', 'OK']);
    assert.equal(facts.paid.length, 1, 'paid once');
    assert.match(facts.paid[0], /^lnbc2500x1/);
    assert.deepEqual(facts.networks, ['mainnet'], 'every bounty lncli call names mainnet');
    assert.equal(facts.feeLimit, '25', '1 % of 2500 sat (at least 20)');
    assert.deepEqual(facts.after, [['paid', 'paid', 'mainnet']]);
  } finally { faucet.kill(); chatServer.close(); rmSync(dir, { recursive: true, force: true }); }
});
