// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2412 (feedback #016 by Hexbox Tools): the reward withdraw links answered {status: ERROR, reason: 'that invoice
// could not be read'} for every valid lnbc invoice of the right amount, and payToAddress failed the same way. The cause
// was not the invoice: the mainnet bounty lnd was LOCKED, `lncli decodepayreq` failed, and bountyDecode read any lncli
// failure as an unreadable invoice. Now a payout wallet that is not ready (lncli state is not SERVER_ACTIVE, or lnd does
// not answer) says so: 'payouts are paused ... your reward stays open', and the reward stays open; an invoice lnd does
// read badly while it is ready is still 'that invoice could not be read'.
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
const MINE = 'https://testnet.example/api/faucet/feedback/mine';
const PRIVATE = 'https://arena-fb-private.example';

test('#2412 a locked payout wallet answers "payouts are paused, your reward stays open" on the withdraw link - not "that invoice could not be read"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-paused-2412-'));
  // A STAND-IN lncli whose wallet is LOCKED while the file `locked` holds "1": every RPC but `state` fails as lnd 0.18+ does
  // ("wallet locked, unlock it to enable full RPC access"); `state` answers LOCKED. Unlocked, it reads and pays as #1450's.
  const lncli = join(dir, 'lncli');
  const locked = join(dir, 'locked');
  writeFileSync(locked, '1');
  writeFileSync(lncli, `#!/bin/bash
cmd=""; for a in "$@"; do case "$a" in decodepayreq|payinvoice|listpayments|state|trackpayment) cmd="$a";; esac; done
echo "$*" >> "${join(dir, 'args.log')}"
inv="\${@: -1}"
if [ "$(cat "${locked}")" = "1" ]; then
  if [ "$cmd" = "state" ]; then echo '{"state": "LOCKED"}'; exit 0; fi
  echo "[lncli] rpc error: code = Unknown desc = wallet locked, unlock it to enable full RPC access" >&2; exit 1
fi
case "$cmd" in
  state) echo '{"state": "SERVER_ACTIVE"}';;
  decodepayreq) case "$inv" in lnbc9*) echo "[lncli] rpc error: code = Unknown desc = invalid index of 1" >&2; exit 1;; esac
    sats=$(echo "$inv" | sed -E 's/^ln(tb|bc)([0-9]+)x.*/\\2/'); echo "{\\"num_satoshis\\":\\"$sats\\",\\"payment_hash\\":\\"$(echo -n "$inv" | sha256sum | cut -c1-64)\\"}";;
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
    const admin = openFeedbackStore(db);
    admin.approve(ev.id, 2500, { played: () => true, by: 'admin' });
    const k1 = admin.createReward(ev.id, { network: 'mainnet' }).reward.k1;
    admin.close();
    const cb = (pr) => fetch(`${base}/lnurlw/${k1}/callback?k1=${k1}&pr=${pr}`).then((r) => r.json());
    const stateOf = () => { const s = openFeedbackStore(db); try { return s.reward(k1).state; } finally { s.close(); } };

    const whileLocked = await cb('lnbc2500x1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const stateLocked = stateOf();
    writeFileSync(locked, '0');
    const unreadable = await cb('lnbc9999x1ddddddddddddddddddddddddddddddd');
    const unlocked = await cb('lnbc2500x1ccccccccccccccccccccccccccccccc');
    let paid = []; try { paid = readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n'); } catch { paid = []; }
    const facts = { whileLocked, stateLocked, unreadable, unlocked, paid, stateAfter: stateOf() };
    console.log('  FACTS #2412:', JSON.stringify(facts));
    assert.equal(whileLocked.status, 'ERROR');
    assert.doesNotMatch(whileLocked.reason, /could not be read/, 'a locked wallet is not the invoice\'s fault');
    assert.match(whileLocked.reason, /payouts are paused/);
    assert.match(whileLocked.reason, /stays open/);
    assert.equal(stateLocked, 'open', 'the reward stays open while payouts are paused');
    assert.equal(unreadable.status, 'ERROR');
    assert.match(unreadable.reason, /could not be read/, 'an invoice a ready wallet cannot read is still the invoice\'s fault');
    assert.equal(unlocked.status, 'OK', 'once the wallet is ready the same link pays');
    assert.equal(paid.length, 1);
    assert.equal(facts.stateAfter, 'paid');
  } finally { faucet.kill(); chatServer.close(); }
});

test('#2412 payToAddress says payouts are paused, and the reward stays open, when the payout wallet is not ready', async () => {
  const s = openFeedbackStore();
  try {
    const k = key(2);
    const e = signed(k, FEEDBACK_KIND, [['t', 'bug'], ['lud16', 'someone@wallet.example']],
      JSON.stringify({ happened: 'The node reads a request body with no size limit, so one large POST fills its memory.', expected: '', lnAddress: 'someone@wallet.example' }));
    s.take(e);
    assert.equal(s.approve(e.id, 5000, { played: () => true }).ok, true);
    const w = s.createReward(e.id, { network: 'mainnet' });
    let paidCalls = 0;
    const r = await s.payToAddress(w.reward.k1, { invoiceFor: async () => ({ ok: true, invoice: 'lnbc50000n1paused' }),
      decode: async () => ({ ok: false, paused: true }), pay: async () => { paidCalls++; return { ok: true }; }, network: 'mainnet' });
    console.log('  FACTS #2412 payToAddress:', JSON.stringify({ ok: r.ok, why: r.why, state: s.reward(w.reward.k1).state, paidCalls }));
    assert.equal(r.ok, false);
    assert.match(r.why, /payouts are paused/);
    assert.equal(s.reward(w.reward.k1).state, 'open');
    assert.equal(paidCalls, 0);
  } finally { s.close(); }
});
