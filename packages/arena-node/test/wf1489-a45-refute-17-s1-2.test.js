// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17-2 (refutes #1828): the publish queue drops its OLDEST waiting receipt when more than ZAP_PUBLISH_QUEUED (1000)
// wait, and nothing ever sends a dropped receipt again (pending is already cleared, `receipts` is memory only). Four silent-relay
// zaps hold the 4 slots; the honest receipt waits behind them; 1000 more 1-sat zaps paid in the next 10 s push it out unsent.
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

test('#1489 a45-refute-17-2: later zaps do not push an honest receipt out of the publish queue unsent', { timeout: 120000 }, async () => {
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => silent.on('listening', x));
  const seen = new Map();
  const good = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => good.on('listening', x));
  good.on('connection', (ws) => ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'EVENT') { seen.set(m[1].id, Date.now()); ws.send(JSON.stringify(['OK', m[1].id, true, ''])); } }));
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const logs = [];
  const z = await serveZapAddresses({ allowPrivateRelays: true, /* local test relays, kanban #2454 */ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) }),
    publish: async (receipt, relays) => { await Promise.allSettled(relays.map((r) => sendToRelay(r, [receipt]))); },
    watchMs: 3600000, log: (s) => logs.push(s) });
  try {
    const to = keyPair();
    const zap = async (payer, relays) => {
      const request = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays }), { secret: payer.secret, curve });
      const said = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
      assert.ok(said.pr, JSON.stringify(said));
      return request;
    };
    const sil = `ws://127.0.0.1:${silent.address().port}/`;
    const strangers = Array.from({ length: 101 }, keyPair);
    for (let i = 0; i < 4; i++) await zap(strangers[100], [sil + i]);
    const mine = await zap(keyPair(), [`ws://127.0.0.1:${good.address().port}/`]);
    const t0 = Date.now();
    await z.watch();                                   // 4 in flight on silent relays, the honest receipt waiting
    const receipt = z.receipts.find((r) => r.tags.some((t) => t[0] === 'description' && JSON.parse(t[1]).id === mine.id));
    for (let k = 0; k < 100; k++) for (let i = 0; i < 10; i++) await zap(strangers[k], [sil + `k${k}i${i}`]);   // 1000 sat
    await z.watch();                                   // 1000 more paid
    console.log(`1000 more paid by +${Date.now() - t0} ms; dropped: ${logs.filter((l) => l.includes('dropped: the queue is full')).length}`);
    await new Promise((x) => setTimeout(x, Math.max(0, t0 + 14000 - Date.now())));
    const at = seen.get(receipt.id);
    console.log(`at +${Date.now() - t0} ms the honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'was NEVER sent: dropped from the publish queue'}`);
    assert.ok(at, 'the honest receipt was dropped unsent from the full publish queue');
  } finally {
    for (const c of silent.clients) c.terminate();
    for (const c of good.clients) c.terminate();
    await new Promise((x) => silent.close(x));
    await new Promise((x) => good.close(x));
    await z.close();
  }
});
