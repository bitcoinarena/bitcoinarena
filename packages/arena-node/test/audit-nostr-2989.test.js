// kanban #2989: the card's test (audit nostr r1-3)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr-r1 #3: EVERY ZAP CALLBACK RE-PARSES EVERY OPEN ZAP'S REQUEST (P5: one stranger stalls the zap server's only thread).
// zap-address.js callback, before any bound is checked: `[...pending.values(), ...letGo.values()].map((p) => [p, requestOf(p)])` -
// a JSON.parse of the kept description of every open and let-go zap, on every call. Strangers may keep ZAP_MINTS_ALL invoices per
// 10 minutes open for the invoices' hour (~2,100), and a zap request's content has no length bound (only the URL's ~16 KB), so each
// description can be several KB. After that, the stranger replays ONE signed, fresh request (no mint, no new key, no bound: the
// same request is answered with its invoice again) as fast as it likes, and each call parses megabytes of JSON on the event loop
// that also mints honest invoices and signs and sends their receipts.
// Safe behaviour asserted: one callback call does a bounded number of JSON parses, whatever many zaps are open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_ALL } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const recipient = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
const BIG = 'z'.repeat(6000);   // a zap "message": nothing bounds a zap request's content
const zapReq = () => signNostr({ kind: 9734, tags: [['p', recipient], ['relays', 'wss://relay.example'], ['amount', '1000']], content: BIG },
  { secret: schnorr.utils.randomSecretKey(), curve });
const urlOf = (port, req) => `http://127.0.0.1:${port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(req))}`;

test('audit nostr-r1 #3: a replayed zap callback parses every open zap\'s request again', async () => {
  const z = await serveZapAddresses({ publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve, allowPrivateRelays: true,
    invoice: async ({ amountMsat, descriptionHash }) => { const paymentHash = sha(randomBytes(32));
      return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: Buffer.from(paymentHash).toString('hex') }; },
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    // the stranger keeps ZAP_MINTS_ALL zaps open (a fresh key and a fresh proxy address each)
    let opened = 0, replay = null;
    for (let i = 0; i < ZAP_MINTS_ALL; i++) {
      const req = zapReq();
      const j = await (await fetch(urlOf(z.port, req), { headers: { 'x-forwarded-for': `198.18.${(i >> 8) & 255}.${i & 255}` } })).json();
      if (j.pr) { opened++; replay = req; }
    }
    assert.ok(opened >= ZAP_MINTS_ALL - 1, `opened ${opened}`);
    // one replayed call, counted
    const parse = JSON.parse;
    let parses = 0;
    const t = process.hrtime.bigint();
    JSON.parse = function (...a) { parses++; return parse.apply(this, a); };
    let body;
    try { body = await (await fetch(urlOf(z.port, replay), { headers: { 'x-forwarded-for': '203.0.113.9' } })).text(); }
    finally { JSON.parse = parse; }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`  ${opened} open zaps of ${BIG.length} B each: one replayed call did ${parses} JSON parses in ${ms.toFixed(1)} ms; answer ${body.slice(0, 40)}`);
    assert.ok(parses <= 20, `one replayed callback did ${parses} JSON parses (one per open zap): the cost of a call grows with the book`);
  } finally { await z.close(); }
});

