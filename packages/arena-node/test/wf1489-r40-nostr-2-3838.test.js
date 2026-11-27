// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40 nostr-2: BYPASS OF #3379 (the zap address's all-callers mint cap ZAP_MINTS_ALL is first come, first served).
//
// The #3379 fix bounds only KEYLESS plain tips (ZAP_TIPS_ALL, 150 of the window's 300) so that "the rest stays for signed zap requests". But a
// signed zap request costs a stranger nothing: Nostr keys are free, a 9734 is one local signature, it needs no payment and no relay, and
// ZAP_PENDING_PER_PAYER (10) is per key. Ten addresses (ten IPv4 addresses or ten /64s of one /48) each send 30 signed zap requests under fresh
// keys (amount and relays tag as NIP-57 wants), never paid: all 300 of the window are minted for the stranger, and every honest zapper's
// callback is refused 'this Lightning address mints at most 300 invoices per 10 minutes; try again later' - the #3379 effect, unchanged,
// with signed requests in place of plain tips. Renewed each 10-minute window.
// Safe (the #3379 test's own rule): an asker that has minted nothing in the window still gets its invoice while one stranger's few
// addresses hold the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_PER_ASKER, ZAP_MINTS_ALL } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const recipient = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
const zapReq = (amount, secret) => signNostr({ kind: 9734, tags: [['p', recipient], ['relays', 'wss://relay.example'], ['amount', String(amount)]], content: '' },
  { secret, curve });

test('r40 nostr-2: ten stranger addresses sending signed zap requests under fresh keys do not refuse an honest zap', async () => {
  let minted = 0;
  const z = await serveZapAddresses({ publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve, allowPrivateRelays: true,
    invoice: async ({ amountMsat, descriptionHash }) => { minted++; const paymentHash = sha(randomBytes(32));
      return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: Buffer.from(paymentHash).toString('hex') }; },
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const addresses = Math.ceil(ZAP_MINTS_ALL / ZAP_MINTS_PER_ASKER);
    let got = 0;
    for (let a = 0; a < addresses; a++) {
      for (let i = 0; i < ZAP_MINTS_PER_ASKER; i++) {
        const amount = 1000 + a * 100 + i;
        const req = zapReq(amount, schnorr.utils.randomSecretKey());   // a fresh key per request: free
        const j = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${amount}&nostr=${encodeURIComponent(JSON.stringify(req))}`,
          { headers: { 'x-forwarded-for': `203.0.113.${a + 1}` } })).json();
        if (j.pr) got++;
      }
    }
    // an honest player zaps from an address that asked nothing this window
    const req = zapReq(21000, schnorr.utils.randomSecretKey());
    const j = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=21000&nostr=${encodeURIComponent(JSON.stringify(req))}`,
      { headers: { 'x-forwarded-for': '198.51.100.77' } })).json();
    console.log(`  FACTS: ${addresses} stranger addresses got ${got} signed-zap invoices (${minted} minted, none paid); the honest zap answered ${JSON.stringify(j.pr ? 'an invoice' : j)}`);
    assert.ok(j.pr, `an honest zap from a fresh address was refused after ${addresses} stranger addresses took the all-callers cap with signed zap requests: ${j.reason}`);
  } finally { await z.close(); }
});
