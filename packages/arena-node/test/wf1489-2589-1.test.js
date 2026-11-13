// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2589 (attacker audit, the feedback-bounty payout, finding 1): a reward paid twice through a node alias.
// lncli prints every HTLC's route as the hops' node ALIASES (cmd/commands/cmd_payments.go formatPayment: aliases.get(hop.PubKey) joined by "->"),
// and an alias is whatever its node announces (32 bytes). paymentFinal() read "not found" ANYWHERE in trackpayment's text as "this payer never
// made that payment" (NONE), and bountyStatus turned NONE into 'failed' - so settle() opened the reward link again while the payment was still in
// flight. The attack: a reporter's own public node named "not found" issues a HOLD invoice for the reward, claims, holds the HTLC past lncli's
// 75 s; three minutes later settle() reads the in-flight payment as failed and opens the link; the reporter claims again with a second hold
// invoice; then settles both: paid twice in real sats. Measured below with a stand-in lncli that prints what lnd 0.21 prints for that payment.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#2589 an in-flight reward payment whose route names a node aliased "not found" is not read as failed: the link is not opened for a second claim', { timeout: 115000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-2589-1-'));
  const H1 = 'a'.repeat(64);
  const lncli = join(dir, 'lncli');
  // trackpayment of the held payment: lnd's table (the route ends at the attacker's node, alias "not found"), then the payment's own line; the
  // stream stays open while the HTLC is held, so lncli is killed by the faucet's 10 s timeout (exec sleep: the kill ends the stream)
  writeFileSync(lncli, `#!/bin/bash
cmd=""; for a in "$@"; do case "$a" in decodepayreq|payinvoice|listpayments|state|trackpayment) cmd="$a";; esac; done
echo "$*" >> "${join(dir, 'args.log')}"
inv="\${@: -1}"
case "$cmd" in
  state) echo '{"state": "SERVER_ACTIVE"}';;
  decodepayreq) sats=$(echo "$inv" | sed -E 's/^ln(tb|bc)([0-9]+)x.*/\\2/'); echo "{\\"num_satoshis\\":\\"$sats\\",\\"payment_hash\\":\\"$(echo -n "$inv" | sha256sum | cut -c1-64)\\"}";;
  payinvoice) echo "$inv" >> "${join(dir, 'paid.log')}"; echo "Payment hash: $(echo -n "$inv" | sha256sum | cut -c1-64)"; echo "Payment status: SUCCEEDED";;
  trackpayment) echo "+------------+--------------+--------------+--------------+-----+----------+--------------------+------------------+"
    echo "| HTLC_STATE | ATTEMPT_TIME | RESOLVE_TIME | RECEIVER_AMT | FEE | TIMELOCK | CHAN_OUT           | ROUTE            |"
    echo "+------------+--------------+--------------+--------------+-----+----------+--------------------+------------------+"
    echo "| IN_FLIGHT  |        0.123 |              | 2500         | 1   |   871234 | 957414234567884801 | ACINQ->not found |"
    echo "+------------+--------------+--------------+--------------+-----+----------+--------------------+------------------+"
    echo "Amount + fee:   0 + 0 sat"; echo "Payment hash:   ${H1}"; echo "Payment status: IN_FLIGHT"; exec sleep 30;;
  listpayments) echo '{"payments":[]}';;
esac
`);
  chmodSync(lncli, 0o755);
  writeFileSync(join(dir, 'token'), 'x');
  const db = join(dir, 'feedback.db');
  // the first claim, four minutes ago: its hold invoice's HTLC is still held, lncli timed out -> the reward is paying under H1
  const seed = openFeedbackStore(db);
  const ev = signed(key(7), FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The withdraw page shows the wrong amount after a reload of the reward link, every time.' }));
  assert.equal(seed.take(ev).ok, true);
  assert.equal(seed.approve(ev.id, 2500, { played: () => true, by: 'admin' }).ok, true);
  const k1 = seed.createReward(ev.id, { network: 'mainnet' }).reward.k1;
  const first = await seed.claim(k1, 'lnbc2500x1hold1', { decode: async () => ({ ok: true, amountSats: 2500, paymentHash: H1 }),
    pay: async () => ({ ok: false, why: 'the payment timed out' }), network: 'mainnet', nowMs: Date.now() - 240000 });
  assert.match(first.reason, /not settled yet/);
  assert.equal(seed.reward(k1).state, 'paying');
  seed.close();

  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FEEDBACK_MINE_URLS: 'https://testnet.example/api/faucet/feedback/mine', FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: 'https://arena-fb-private.example', FAUCET_BOUNTY_NETWORK: 'mainnet' } });
  const base = `http://127.0.0.1:${port}`;
  const log = () => { try { return readFileSync(join(dir, 'args.log'), 'utf8'); } catch { return ''; } };
  const stateOf = () => { const s = openFeedbackStore(db); try { return s.reward(k1).state; } finally { s.close(); } };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await sleep(100); } }
    // the faucet's settle pass runs once a minute: wait for its trackpayment, then for lncli's 10 s timeout and the decision
    const t0 = Date.now();
    while (!/trackpayment/.test(log()) && Date.now() - t0 < 80000) await sleep(500);
    await sleep(12000);
    const afterSettle = stateOf();
    const second = await fetch(`${base}/lnurlw/${k1}/callback?k1=${k1}&pr=lnbc2500x1hold2`).then((r) => r.json());
    let paid = []; try { paid = readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { paid = []; }
    const facts = { tracked: /trackpayment/.test(log()), afterSettle, second, secondPayInvoice: paid, stateAfter: stateOf() };
    console.log('  FACTS #2589-1:', JSON.stringify(facts));
    assert.equal(facts.tracked, true, 'settle asked lnd about the paying reward');
    assert.equal(afterSettle, 'paying', 'a payment lnd still has in flight is not failed: the link stays closed');
    assert.equal(second.status, 'ERROR', 'no second claim while the first payment is in flight');
    assert.deepEqual(paid, [], 'no second payment was sent');
  } finally { faucet.kill(); chatServer.close(); }
});
