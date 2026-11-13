// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2443 (#1489 a44-refute-18-s2, refutes #1619 / #2141), adapted to 1.9 by #2536: the attack was a stranger with free Nostr keys
// (ten unpaid zap requests each) pushing an honest zap just minted through the book and out, until LND cancelled its invoice before the
// honest zapper paid it. 1.9 cancels nothing (#1922: a zap let go from a full book is watched until its invoice expires) and bounds what
// all callers behind the proxy mint together (ZAP_MINTS_ALL per window). The same flood, both ways a stranger can send it:
// 1. behind the proxy, every request from its own address: no honest invoice is cancelled, and paid, it gets its receipt;
// 2. with no mint bound at all (a caller on the host itself) and LND failing the honest lookup during the flood, so the honest zap is let
//    go from the full book: it is still watched, and paid, it gets its receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX, ZAP_PENDING_PER_PAYER, ZAP_LET_GO_MAX } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const hasReceipt = (published, pr) => published.some((r) => r.tags.some(([t, v]) => t === 'bolt11' && v === pr));

async function stand() {
  const byInvoice = new Map();
  const settled = new Set();
  const cancelled = new Set();
  const published = [];
  const lnd = { busy: null };
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    const request = testInvoice({ amountMsat, paymentHash, descriptionHash });
    byInvoice.set(request, hex(paymentHash));
    return { request, paymentHash: hex(paymentHash) };
  };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice,
    lookup: async ({ paymentHash }) => {
      if (lnd.busy === paymentHash) throw new Error('lnd: connection refused');
      return settled.has(paymentHash) ? { settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) } : { settled: false };
    },
    cancel: async ({ paymentHash }) => { if (settled.has(paymentHash)) throw new Error('already settled'); cancelled.add(paymentHash); },
    publish: async (r) => { published.push(r); }, watchMs: 3600000 });
  const ask = async (payer, to, n, ip = null) => {
    const request = signNostr(zapRequestTemplate({ recipient: to, amountMsat: 1000n, relays: ['wss://relay.example'], comment: `n${n}` }), { secret: payer.secret, curve });
    const headers = ip ? { 'cf-connecting-ip': ip } : {};
    return (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`, { headers })).json();
  };
  return { z, ask, byInvoice, settled, cancelled, published, lnd };
}

async function flood(ask, to, keys, ipOf) {
  let n = 0; let minted = 0; let refused = 0;
  for (let k = 0; k < keys; k++) {
    const stranger = keyPair();
    const asks = [];
    for (let i = 0; i < ZAP_PENDING_PER_PAYER; i++) { asks.push(ask(stranger, to, n, ipOf ? ipOf(n) : null)); n++; }
    for (const said of await Promise.all(asks)) if (said.pr) minted++; else refused++;
  }
  return { sent: n, minted, refused };
}

test('#2443 (1.9): strangers behind the proxy, each request its own address, flooding past book + let-go room cancel no honest zap; paid, it gets its receipt', { timeout: 120000 }, async () => {
  const w = await stand();
  try {
    const to = keyPair().pubkey;
    const honest = await w.ask(keyPair(), to, 'honest', '203.0.113.7');
    assert.ok(honest.pr, JSON.stringify(honest));
    const honestHash = w.byInvoice.get(honest.pr);
    const keys = (ZAP_PENDING_MAX + ZAP_LET_GO_MAX) / ZAP_PENDING_PER_PAYER + 1;
    const f = await flood(w.ask, to, keys, (n) => `198.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
    console.log(`  FACTS: sent ${f.sent}, minted ${f.minted}, refused ${f.refused}; pending ${w.z.pending.size}, letGo ${w.z.letGo.size}; cancelled ${w.cancelled.size}`);
    assert.equal(w.cancelled.size, 0, 'no invoice is cancelled');
    assert.ok(w.z.pending.has(honestHash) || w.z.letGo.has(honestHash), 'the honest zap is still watched');
    w.settled.add(honestHash);
    await w.z.watch();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(hasReceipt(w.published, honest.pr), 'the honest zap was paid and has no receipt');
  } finally { await w.z.close(); }
});

test('#2443 (1.9): with no mint bound and the honest lookup failing during the flood, the honest zap let go from the full book is watched; paid, it gets its receipt', { timeout: 120000 }, async () => {
  const w = await stand();
  try {
    const to = keyPair().pubkey;
    const honest = await w.ask(keyPair(), to, 'honest');
    assert.ok(honest.pr, JSON.stringify(honest));
    const honestHash = w.byInvoice.get(honest.pr);
    w.lnd.busy = honestHash;
    const f = await flood(w.ask, to, ZAP_PENDING_MAX / ZAP_PENDING_PER_PAYER + 10, null);
    await new Promise((r) => setTimeout(r, 100));
    w.lnd.busy = null;
    console.log(`  FACTS: sent ${f.sent}, minted ${f.minted}, refused ${f.refused}; honest pending ${w.z.pending.has(honestHash)} letGo ${w.z.letGo.has(honestHash)}; cancelled ${w.cancelled.size}`);
    assert.equal(w.cancelled.size, 0, 'no invoice is cancelled');
    assert.ok(w.z.letGo.has(honestHash), 'the flood pushed the honest zap out of the book');
    w.settled.add(honestHash);
    for (let i = 0; i < 3; i++) await w.z.watch();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(hasReceipt(w.published, honest.pr), `the honest zap let go from the book was paid and has no receipt (letGo ${w.z.letGo.has(honestHash)})`);
  } finally { await w.z.close(); }
});
