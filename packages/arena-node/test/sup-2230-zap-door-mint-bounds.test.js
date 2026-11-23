// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1754 (a44 item 56): the same callback's other door. #1754 bounds the LND invoices a stranger can
// mint through plain tips, but the zap door (with `nostr`) evicts the oldest open zap at the cap (#1619) and mints a new LND
// invoice anyway - the evicted one stays open at LND for its hour. Nostr keys are free: one fresh key per request (one schnorr
// signature, no payment) mints without bound - the same `lncli addinvoice` child and LND invoice row per call #1754 was about.
// Nor is there a "being made at once" bound on zaps like ZAP_TIPS_MINTING_MAX: up to ZAP_PENDING_MAX invoice() run concurrently.
// Adapted to 1.9 by #2536 (kanban #2230, #2302): 1.9 has no #1754 (ZAP_TIPS_MINTING_MAX); its bounds are per asker (the address the proxy
// saw, cf-connecting-ip / X-Forwarded-For; #1743, #1801, #1964): ZAP_MINTS_PER_ASKER fresh invoices per window from one address and
// ZAP_MINTS_ALL from all of them together, on both doors. A caller on the host itself with no proxy header is the host's own tools.
// The stranger therefore comes through the proxy: from one address, and from a fresh address each call.
// Safe: strangers' calls mint at most ZAP_MINTS_ALL LND invoices per window (one address ZAP_MINTS_PER_ASKER), and no more than
// ZAP_MINTING_MAX (16, the #1754 figure) at once on either door (kanban #2302).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX, ZAP_MINTS_PER_ASKER, ZAP_MINTS_ALL } from '../src/zap-address.js';
import * as zapAddress from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const ZAP_MINTING_MAX = zapAddress.ZAP_MINTING_MAX ?? 16;
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const recipient = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
const zapReq = (amount) => signNostr({ kind: 9734, tags: [['p', recipient], ['relays', 'wss://relay.example'], ['amount', String(amount)]], content: '' },
  { secret: schnorr.utils.randomSecretKey(), curve });
const ipOf = (i) => `198.18.${(i >> 8) & 255}.${i & 255}`;
const zapUrl = (port) => `http://127.0.0.1:${port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(zapReq(1000)))}`;
const tipUrl = (port, i) => `http://127.0.0.1:${port}/lnurlp/bob/cb?amount=${1000 + i}`;
const mintingServer = (onInvoice) => serveZapAddresses({ publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve,
  invoice: async ({ amountMsat, descriptionHash }) => { await onInvoice(); const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: Buffer.from(paymentHash).toString('hex') }; },
  lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });

for (const [who, ipFor, cap] of [['one stranger address', () => '203.0.113.7', ZAP_MINTS_PER_ASKER], ['a fresh address each call', ipOf, ZAP_MINTS_ALL]]) {
  test(`#2230 (1.9) a44-refute-56-2: fresh-key zap requests from ${who} cannot mint unbounded LND invoices`, async () => {
    let minted = 0;
    const z = await mintingServer(async () => { minted++; });
    try {
      let answered = 0;
      for (let i = 0; i < ZAP_PENDING_MAX + 100; i++) {
        const j = await (await fetch(zapUrl(z.port), { headers: { 'cf-connecting-ip': ipFor(i) } })).json();
        if (j.pr) answered++;
      }
      console.log(`  ${who}: minted ${minted}, handed out ${answered}, bound ${cap}`);
      assert.ok(minted <= cap, `a stranger had ${minted} LND invoices minted through the zap door (${answered} handed out), past ${cap}`);
    } finally { await z.close(); }
  });
}
