// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_PER_ASKER, ZAP_PENDING_MAX, ZAP_PENDING_PER_PAYER } from '../src/zap-address.js';
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

// kanban #1489 v1-refute-19-s2 (#1514, #1743): the full book "gives way" by dropping the OLDEST open zap - an honest one. A stranger
// behind Cloudflare with an IPv6 /64 (each address its own asker) and free keys mints ZAP_PENDING_MAX zaps; the honest zap is let go
// unpaid (its one last look sees nothing yet), the honest payer then pays it from the invoice he holds, and no receipt is ever made.
test('#1489 v1-refute-19-s2-1: an honest open zap paid after strangers fill the book still gets its receipt', async () => {
  const st = { minted: 0 };
  const paidHashes = new Set();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async ({ paymentHash }) => ({ settled: paidHashes.has(paymentHash), preimage: null }), publish: async () => {}, watchMs: 3600000 });
  try {
    const to = keyPair();
    const url = (r) => `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(r))}`;
    let n = 0;
    const zapReq = (k) => signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'], comment: `zap ${n++}` }), { secret: k.secret, curve });
    const honest = await (await fetch(url(zapReq(keyPair())), { headers: { 'cf-connecting-ip': '198.51.100.20' } })).json();
    assert.ok(honest.pr, JSON.stringify(honest));
    const honestHash = [...z.pending.keys()][0];
    let key = keyPair();
    for (let i = 0; i < ZAP_PENDING_MAX; i++) {
      if (i % ZAP_PENDING_PER_PAYER === 0) key = keyPair();
      const ip = `2001:db8:77:1::${Math.floor(i / ZAP_MINTS_PER_ASKER).toString(16)}`;   // one /64, a new address each 30 mints
      await (await fetch(url(zapReq(key)), { headers: { 'cf-connecting-ip': ip } })).json();
    }
    paidHashes.add(honestHash);                       // the honest payer pays the invoice he was handed
    await z.watch();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(z.receipts.length, 1, `honest zap paid after ${st.minted} stranger mints (book ${z.pending.size}, honest still open: ${z.pending.has(honestHash)}): ${z.receipts.length} receipts`);
  } finally { await z.close(); }
});
