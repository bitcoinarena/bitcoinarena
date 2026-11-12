// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-19 (#1514): the per-payer cap is per KEY, and keys are free. A stranger signs ZAP_PENDING_MAX requests
// with fresh keys (one each); every one mints an invoice, and then an honest zapper is refused for the hour the invoices stay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 v1-refute-19-s1-2: fresh keys cannot fill the open-zap cap and lock out an honest zapper', async () => {
  let minted = 0;
  const invoice = async ({ amountMsat, descriptionHash }) => {
    minted++;
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const to = keyPair();
    const url = (r) => `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(r))}`;
    for (let i = 0; i < ZAP_PENDING_MAX; i++) {
      const k = keyPair();
      await (await fetch(url(signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: k.secret, curve })))).json();
    }
    const honest = keyPair();
    const said = await (await fetch(url(signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: honest.secret, curve })))).json();
    assert.ok(said.pr, `after ${minted} invoices from ${ZAP_PENDING_MAX} throwaway keys (${z.pending.size} pending), an honest zap: ${JSON.stringify(said)}`);
  } finally { await z.close(); }
});
