// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-19 (#1514): the other door. The plain-tip callback (no nostr parameter) has no bound at all: every call is
// one more lncli addinvoice, the same URL replayed included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };

test('#1489 v1-refute-19-s1-3: a replayed plain tip callback does not mint an invoice each time', async () => {
  let minted = 0;
  const invoice = async ({ amountMsat, descriptionHash }) => {
    minted++;
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve, invoice,
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const url = `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000`;
    for (let i = 0; i < 200; i++) await (await fetch(url)).json();
    assert.ok(minted <= 50, `200 replays of one plain tip URL: ${minted} LND invoices minted`);
  } finally { await z.close(); }
});
