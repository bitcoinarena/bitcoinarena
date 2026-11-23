// kanban #3379: the card's test (audit nostr a6-3-4)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a6-3-4: THE ZAP ADDRESS'S ALL-CALLERS MINT CAP (#1964 / #2230) IS FIRST COME, FIRST SERVED. zap-address.js mayMint counts
// ZAP_MINTS_PER_ASKER (30) fresh invoices per asker (an IPv4 address, an IPv6 /64) and ZAP_MINTS_ALL (300) for all strangers together in a
// 10-minute window. Ten addresses (ten IPv4 addresses, or ten /64s of one /48) each asking 30 plain tips of new amounts - no payment, no key,
// no signature - use the whole 300, and from then on every honest zapper's callback (a signed NIP-57 zap request from an address that minted
// nothing) is refused 'this Lightning address mints at most 300 invoices per 10 minutes', for the window, renewed by the stranger each window.
// Safe: an asker that has minted nothing in the window still gets its invoice while one stranger's few addresses hold the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_PER_ASKER, ZAP_MINTS_ALL } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const recipient = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');

test('ten stranger addresses asking plain tips do not refuse an honest zap at the zap address', async () => {
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
        const j = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${1000 + a * 100 + i}`, { headers: { 'x-forwarded-for': `203.0.113.${a + 1}` } })).json();
        if (j.pr) got++;
      }
    }
    // an honest player zaps from an address that asked nothing this window
    const req = signNostr({ kind: 9734, tags: [['p', recipient], ['relays', 'wss://relay.example'], ['amount', '21000']], content: 'gg' },
      { secret: schnorr.utils.randomSecretKey(), curve });
    const j = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=21000&nostr=${encodeURIComponent(JSON.stringify(req))}`,
      { headers: { 'x-forwarded-for': '198.51.100.77' } })).json();
    console.log(`  FACTS: ${addresses} stranger addresses got ${got} tip invoices (${minted} minted); the honest zap answered ${JSON.stringify(j.pr ? 'an invoice' : j)}`);
    assert.ok(j.pr, `an honest zap from a fresh address was refused after ${addresses} stranger addresses took the all-callers cap: ${j.reason}`);
  } finally { await z.close(); }
});
