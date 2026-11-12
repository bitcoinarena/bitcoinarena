// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1683, #1743, #1801 (v1-refute-19-s1): the rest of the bound. One address behind the proxy mints at most
// ZAP_MINTS_PER_ASKER invoices a window, whatever keys, amounts or doors it uses; tips of other amounts are not reused; asks for the
// same tip at the same moment share one mint; an open zap let go from a full book that was paid at that moment still gets its receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_PER_ASKER, ZAP_PENDING_MAX } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const minter = (state, delayMs = 0) => async ({ amountMsat, descriptionHash }) => {
  state.minted++;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const paymentHash = sha(randomBytes(32));
  return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
};

test('#1801 #1743: one address behind the proxy mints at most ZAP_MINTS_PER_ASKER invoices, tips and zaps together', async () => {
  const st = { minted: 0 };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const to = keyPair();
    const from = (ip) => ({ headers: { 'cf-connecting-ip': ip } });
    const base = `http://127.0.0.1:${z.port}/lnurlp/bob/cb`;
    for (let i = 0; i < 40; i++) await (await fetch(`${base}?amount=${1000 + i}`, from('203.0.113.7'))).json();
    for (let i = 0; i < 20; i++) {
      const r = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: keyPair().secret, curve });
      await (await fetch(`${base}?amount=1000&nostr=${encodeURIComponent(JSON.stringify(r))}`, from('203.0.113.7'))).json();
    }
    assert.equal(st.minted, ZAP_MINTS_PER_ASKER, `60 asks of new amounts and fresh keys from one address: ${st.minted} minted`);
    const other = await (await fetch(`${base}?amount=5000`, from('198.51.100.9'))).json();
    assert.ok(other.pr, `another address is still served: ${JSON.stringify(other)}`);
  } finally { await z.close(); }
});

test('#1801: tips of the same amount asked at the same moment share one mint; a paid tip invoice is not handed out again', async () => {
  const st = { minted: 0 };
  let settled = false;
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st, 200),
    lookup: async () => ({ settled }), publish: async () => {}, watchMs: 3600000 });
  try {
    const url = `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=2000`;
    const said = await Promise.all(Array.from({ length: 20 }, async () => (await fetch(url)).json()));
    assert.equal(st.minted, 1);
    assert.equal(new Set(said.map((s) => s.pr)).size, 1);
    settled = true;
    const next = await (await fetch(url)).json();
    assert.equal(st.minted, 2, 'the paid one is replaced');
    assert.notEqual(next.pr, said[0].pr);
  } finally { await z.close(); }
});

test('#1743: an open zap let go from a full book that is paid gets its receipt on the last look', async () => {
  const st = { minted: 0 };
  const paidHashes = new Set();
  const published = [];
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async ({ paymentHash }) => ({ settled: paidHashes.has(paymentHash), preimage: null }), publish: async (r) => { published.push(r); }, watchMs: 3600000 });
  try {
    const to = keyPair();
    const url = (r) => `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(r))}`;
    for (let i = 0; i < ZAP_PENDING_MAX; i++) {
      await (await fetch(url(signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: keyPair().secret, curve })))).json();
    }
    const oldest = z.pending.keys().next().value;
    paidHashes.add(oldest);
    const said = await (await fetch(url(signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: keyPair().secret, curve })))).json();
    assert.ok(said.pr);
    assert.equal(z.pending.size, ZAP_PENDING_MAX);
    assert.ok(!z.pending.has(oldest));
    for (let i = 0; i < 50 && !published.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(published.length, 1, 'the let-go zap that was paid is receipted');
    assert.equal(z.receipts.length, 1);
  } finally { await z.close(); }
});
