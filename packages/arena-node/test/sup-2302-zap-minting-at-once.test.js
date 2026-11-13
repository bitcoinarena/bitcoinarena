// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1754 (a44 item 56): the same callback's other door. #1754 bounds the LND invoices a stranger can
// mint through plain tips, but the zap door (with `nostr`) evicts the oldest open zap at the cap (#1619) and mints a new LND
// invoice anyway - the evicted one stays open at LND for its hour. Nostr keys are free: one fresh key per request (one schnorr
// signature, no payment) mints without bound - the same `lncli addinvoice` child and LND invoice row per call #1754 was about.
// Nor is there a "being made at once" bound on zaps like ZAP_TIPS_MINTING_MAX: up to ZAP_PENDING_MAX invoice() run concurrently.
// Adapted to 1.9 by #2536 (kanban #2302, with #2230): 1.9 has no #1754 (ZAP_TIPS_MINTING_MAX); its bounds are per asker (the address the proxy
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

for (const [door, urlOf] of [['zap', (port) => zapUrl(port)], ['plain tip', (port, i) => tipUrl(port, i)]]) {
  test(`#2302 (1.9) a44-refute-56-2b: ${door} invoices being made at once for strangers are bounded`, async () => {
    let running = 0, peak = 0; const hold = [];
    const z = await mintingServer(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => hold.push(r)); running--; });
    try {
      const calls = [];
      for (let i = 0; i < 64; i++) calls.push(fetch(urlOf(z.port, i), { headers: { 'cf-connecting-ip': ipOf(i) } }).then((r) => r.json()));
      await new Promise((r) => setTimeout(r, 1500));
      const seen = peak;
      hold.splice(0).forEach((r) => r()); const late = setInterval(() => { hold.splice(0).forEach((r) => r()); }, 20);
      const said = await Promise.all(calls);
      const after = await (await fetch(urlOf(z.port, 999), { headers: { 'cf-connecting-ip': ipOf(999) } })).json();
      clearInterval(late);
      console.log(`  ${door}: ${seen} at once, ${said.filter((j) => j.pr).length} of 64 handed out, one more after: ${after.pr ? 'handed out' : after.reason}`);
      assert.ok(seen <= ZAP_MINTING_MAX, `${seen} ${door} invoices were being made at once (lncli children), past ${ZAP_MINTING_MAX}`);
      assert.ok(after.pr, 'once the mints in flight are done, the next stranger is served');
    } finally { await z.close(); }
  });
}
