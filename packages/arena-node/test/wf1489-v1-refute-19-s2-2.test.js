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

// kanban #1489 v1-refute-19-s2 (#1801): ZAP_MINTS_PER_ASKER keys on the whole address. Behind Cloudflare an IPv6 caller's
// cf-connecting-ip is its full address, and one /64 holds 2^64 of them: plain tips of new amounts mint without bound.
test('#1489 v1-refute-19-s2-2: one IPv6 /64 is one asker for the mint bound', async () => {
  const st = { minted: 0 };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    for (let i = 0; i < 200; i++) {
      await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${1000 + i}`, { headers: { 'cf-connecting-ip': `2001:db8:77:1::${(i + 1).toString(16)}` } })).json();
    }
    assert.ok(st.minted <= ZAP_MINTS_PER_ASKER, `200 tips from 200 addresses of one /64: ${st.minted} invoices minted`);
  } finally { await z.close(); }
});
