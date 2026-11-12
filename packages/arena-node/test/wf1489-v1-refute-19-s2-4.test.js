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

// kanban #1489 v1-refute-19-s2 (#1801): the plain-tip reuse hands ONE invoice to every tipper of the same name and amount. Two
// players tip the developer the same preset amount a moment apart; both are handed the same bolt11, the first pays it, and the
// second's wallet is refused (an invoice is paid once) - an honest tip fails. Retrying a moment later after the lookup is the
// only way back, and only once the first payment has settled.
test('#1489 v1-refute-19-s2-4: two honest tippers of the same amount are not handed the same invoice', async () => {
  const st = { minted: 0 };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const url = `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=21000`;
    const a = await (await fetch(url, { headers: { 'cf-connecting-ip': '198.51.100.31' } })).json();
    const b = await (await fetch(url, { headers: { 'cf-connecting-ip': '192.0.2.44' } })).json();
    assert.ok(a.pr && b.pr);
    assert.notEqual(a.pr, b.pr, 'two different tippers, one invoice: the second payment is refused');
  } finally { await z.close(); }
});
