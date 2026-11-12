// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r6-nostr-2: ONE ZAP'S RELAYS HOLD EVERY OTHER ZAP'S RECEIPT.
// serveZapAddresses' watch() walks the pending zaps one by one and, for each paid one, AWAITS publish(receipt, relays) before it even
// looks at the next - and the relays are the ones the payer's own zap request named (up to 8, ws:// to any host). The zap tool's
// publish (tools/zap-address.mjs) sends to them one after the other with sendToRelay's 10 s timeout each. So a stranger who pays a
// 1-sat zap naming 8 relays that accept the socket and never answer holds the watcher 80 s per zap: every honest zap paid after it
// gets no receipt (and no expiry sweep runs) until the stranger's relays have timed out; 100 such zaps (100 sat) hold it ~2 hours.
// Safe: a paid zap's receipt is issued without waiting on another zap's relays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr } from '../src/zap-address.js';
import { sendToRelay } from '../src/nostr-results.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 r6-nostr-2: a zap naming silent relays does not hold the next paid zap\'s receipt', async () => {
  // the stranger's "relays": they take the socket and never answer an EVENT
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => silent.on('listening', x));
  const sp = silent.address().port;
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) }),
    // the zap tool's publish, as tools/zap-address.mjs has it: each relay in turn, sendToRelay (10 s timeout each)
    publish: async (receipt, relays) => { for (const r of relays) await sendToRelay(r, [receipt]); },
    watchMs: 3600000 });
  try {
    const to = keyPair();
    const zap = async (payer, relays) => {
      const request = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays }), { secret: payer.secret, curve });
      const said = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
      assert.ok(said.pr, JSON.stringify(said));
      return request;
    };
    const stranger = keyPair(), honest = keyPair();
    await zap(stranger, Array.from({ length: 8 }, (_, i) => `ws://127.0.0.1:${sp}/r${i}`));   // 1 sat, 8 silent relays
    const mine = await zap(honest, ['wss://relay.example']);
    assert.equal(z.pending.size, 2);
    // both are paid; the watcher runs once
    const watching = z.watch();
    await new Promise((x) => setTimeout(x, 3000));
    const got = z.receipts.find((r) => r.tags.some((t) => t[0] === 'description' && JSON.parse(t[1]).id === mine.id));
    console.log(`after 3 s: ${z.receipts.length} receipt(s) issued, the honest zap's ${got ? 'issued' : 'NOT issued'}, ${z.pending.size} still pending`);
    assert.ok(got, 'the honest paid zap got no receipt: the watcher is still waiting on the stranger\'s 8 silent relays (8 x 10 s)');
    void watching;
  } finally {
    for (const c of silent.clients) c.terminate();
    await new Promise((x) => silent.close(x));
    await z.close();
  }
});
