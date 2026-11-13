// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2589 (attacker audit, the feedback-bounty payout, finding 2): an invoice for more than the reward.
// bountyDecode took lnd's num_satoshis, which is the invoice's msat amount cut DOWN to whole sats; payinvoice pays the invoice's own msat amount.
// An invoice for 2,500,999 msat decoded as 2500 sat, passed claim()'s "exactly 2500 sat", and was paid 2500.999 sat. Now the amount is read in
// msat (num_msat) and an invoice that is not exactly the reward is refused.
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
import { FEEDBACK_KIND, openFeedbackStore } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#2589 a withdraw invoice for 999 msat more than the reward is refused, the exact one is paid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-2589-2-'));
  const lncli = join(dir, 'lncli');
  // decodepayreq as lnd answers it: num_satoshis is the msat amount cut to whole sats, num_msat the amount itself; "lnbc<sats>x<extra msat>m..."
  writeFileSync(lncli, `#!/bin/bash
cmd=""; for a in "$@"; do case "$a" in decodepayreq|payinvoice|listpayments|state|trackpayment) cmd="$a";; esac; done
inv="\${@: -1}"
case "$cmd" in
  state) echo '{"state": "SERVER_ACTIVE"}';;
  decodepayreq) sats=$(echo "$inv" | sed -E 's/^ln(tb|bc)([0-9]+)x([0-9]+)m.*/\\2/'); extra=$(echo "$inv" | sed -E 's/^ln(tb|bc)([0-9]+)x([0-9]+)m.*/\\3/')
    echo "{\\"num_satoshis\\":\\"$sats\\",\\"num_msat\\":\\"$((sats * 1000 + extra))\\",\\"payment_hash\\":\\"$(echo -n "$inv" | sha256sum | cut -c1-64)\\"}";;
  payinvoice) echo "$inv" >> "${join(dir, 'paid.log')}"; echo "Payment hash: $(echo -n "$inv" | sha256sum | cut -c1-64)"; echo "Payment status: SUCCEEDED";;
  listpayments) echo '{"payments":[]}';;
esac
`);
  chmodSync(lncli, 0o755);
  writeFileSync(join(dir, 'token'), 'x');
  const db = join(dir, 'feedback.db');
  const seed = openFeedbackStore(db);
  const ev = signed(key(8), FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The withdraw page shows the wrong amount after a reload of the reward link, every time.' }));
  assert.equal(seed.take(ev).ok, true);
  assert.equal(seed.approve(ev.id, 2500, { played: () => true, by: 'admin' }).ok, true);
  const k1 = seed.createReward(ev.id, { network: 'mainnet' }).reward.k1;
  seed.close();
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FEEDBACK_MINE_URLS: 'https://testnet.example/api/faucet/feedback/mine', FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: 'https://arena-fb-private.example', FAUCET_BOUNTY_NETWORK: 'mainnet' } });
  const base = `http://127.0.0.1:${port}`;
  const cb = (pr) => fetch(`${base}/lnurlw/${k1}/callback?k1=${k1}&pr=${pr}`).then((r) => r.json());
  const paidLog = () => { try { return readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const over = await cb('lnbc2500x999m1aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const paidAfterOver = paidLog();
    const exact = await cb('lnbc2500x0m1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const facts = { over, paidAfterOver, exact, paid: paidLog() };
    console.log('  FACTS #2589-2:', JSON.stringify(facts));
    assert.equal(over.status, 'ERROR', 'an invoice for 2500.999 sat is not the 2500 sat reward');
    assert.match(over.reason, /exactly 2500 sat/);
    assert.deepEqual(paidAfterOver, [], 'nothing was paid for it');
    assert.equal(exact.status, 'OK', 'the exact invoice is paid');
    assert.deepEqual(facts.paid, ['lnbc2500x0m1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  } finally { faucet.kill(); chatServer.close(); }
});
