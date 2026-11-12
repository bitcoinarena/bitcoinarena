// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (nostr/zaps): #1514 capped the zap address's open invoices - but only on the zap path (a `nostr`
// request). The plain-tip path of the same callback (GET /lnurlp/<name>/cb?amount=1000, no `nostr`) needs no key, no
// signature and no payment, and every call runs invoice() - in tools/zap-address.mjs one `lncli addinvoice` child process and
// one LND invoice row (an hour's expiry) each - with no cap on how many are open or being made at once. A stranger loops the
// URL: the LND's invoice table grows without bound and the host forks lncli per request.
// Safe: plain tips are held to a bound like zaps (here: no more than ZAP_PENDING_MAX open invoices from strangers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, ZAP_PENDING_MAX } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };

test('r5-nostr-3: a stranger cannot mint unbounded plain-tip invoices at the zap address', async () => {
  let minted = 0;
  const z = await serveZapAddresses({ publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve,
    invoice: async ({ amountMsat, descriptionHash }) => { minted++; const pre = randomBytes(32); const paymentHash = sha(pre);
      return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: Buffer.from(paymentHash).toString('hex') }; },
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    let answered = 0;
    for (let i = 0; i < ZAP_PENDING_MAX + 100; i++) {
      const res = await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000`);
      const j = await res.json();
      if (j.pr) answered++;
    }
    assert.ok(minted <= ZAP_PENDING_MAX, `one stranger had ${minted} invoices minted (${answered} handed out), past the zap cap of ${ZAP_PENDING_MAX}`);
  } finally { await z.close(); }
});
