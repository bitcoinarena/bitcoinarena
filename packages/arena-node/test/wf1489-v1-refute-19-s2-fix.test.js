// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX, ZAP_MINTS_ALL, askerKey } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const minter = (st) => async ({ amountMsat, descriptionHash }) => {
  st.minted++;
  const paymentHash = sha(randomBytes(32));
  return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
};

// kanban #1922: a zap let go from a full book, still unpaid at its first look, is watched until it expires and receipted when paid later
test('#1922: a let-go zap paid after its first look gets its receipt from watch()', async () => {
  const st = { minted: 0 };
  const paidHashes = new Set();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async ({ paymentHash }) => ({ settled: paidHashes.has(paymentHash), preimage: null }), publish: async () => {}, watchMs: 3600000 });
  try {
    const to = keyPair();
    const url = (r) => `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(r))}`;
    const zap = () => signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: keyPair().secret, curve });
    for (let i = 0; i < ZAP_PENDING_MAX; i++) await (await fetch(url(zap()))).json();
    const oldest = z.pending.keys().next().value;
    assert.ok((await (await fetch(url(zap()))).json()).pr);
    await new Promise((r) => setTimeout(r, 100));             // its first look: unpaid
    assert.ok(!z.pending.has(oldest) && z.letGo.has(oldest));
    assert.equal(z.receipts.length, 0);
    paidHashes.add(oldest);
    await z.watch();
    assert.equal(z.receipts.length, 1);
    assert.ok(!z.letGo.has(oldest));
    await z.watch();
    assert.equal(z.receipts.length, 1, 'receipted once');
  } finally { await z.close(); }
});

// kanban #1964: rotating askers (here 400 IPv4 addresses) cannot mint more than ZAP_MINTS_ALL per window together; this host's tools still can
test('#1964: all remote askers together mint at most ZAP_MINTS_ALL invoices a window', async () => {
  const st = { minted: 0 };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    for (let i = 0; i < ZAP_MINTS_ALL + 100; i++) {
      await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${1000 + i}`, { headers: { 'cf-connecting-ip': `198.51.${100 + (i >> 8)}.${i & 255}` } })).json();
    }
    assert.equal(st.minted, ZAP_MINTS_ALL);
    assert.ok((await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=999999`)).json()).pr, 'this host is not limited');
    assert.equal(askerKey('2001:DB8:77:1:aa:bb:cc:dd'), askerKey('2001:db8:77:1::1'));
    assert.notEqual(askerKey('2001:db8:77:1::1'), askerKey('2001:db8:77:2::1'));
  } finally { await z.close(); }
});
