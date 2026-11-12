// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-nostr-3: THE ZAP ADDRESS'S OPEN-ZAP CAP IS A STRANGER'S OFF SWITCH.
// The #1514 fix bounds open zap invoices: ZAP_PENDING_PER_PAYER (10) per zap-request key and ZAP_PENDING_MAX (1000) in all, each
// open for expiryS (an hour). The per-payer bound is by the request's pubkey, and Nostr keys are free: a stranger signs 10 zap
// requests under each of 100 fresh keys (nothing paid - an invoice is minted on the GET) and the address answers every honest
// zapper "too many zaps are open here" for the next hour; again every hour, for nothing.
// Safe: unpaid invoices from strangers' fresh keys do not stop an honest zapper's zap from being invoiced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX, ZAP_PENDING_PER_PAYER } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 r4-nostr-3: unpaid zap invoices under fresh keys do not refuse an honest zap', async () => {
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  const ask = async (payer, to, n) => {
    const request = signNostr(zapRequestTemplate({ recipient: to, amountMsat: 1000n, relays: ['wss://relay.example'], comment: `n${n}` }), { secret: payer.secret, curve });
    return (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
  };
  try {
    const to = keyPair().pubkey;
    let n = 0;
    for (let k = 0; k < ZAP_PENDING_MAX / ZAP_PENDING_PER_PAYER; k++) {
      const stranger = keyPair();
      const asks = [];
      for (let i = 0; i < ZAP_PENDING_PER_PAYER; i++) asks.push(ask(stranger, to, n++));
      for (const said of await Promise.all(asks)) assert.ok(said.pr, JSON.stringify(said));
    }
    const honest = await ask(keyPair(), to, 'honest');
    assert.ok(honest.pr, `an honest zap after ${z.pending.size} unpaid invoices under ${ZAP_PENDING_MAX / ZAP_PENDING_PER_PAYER} fresh keys: ${JSON.stringify(honest)}`);
  } finally { await z.close(); }
});
