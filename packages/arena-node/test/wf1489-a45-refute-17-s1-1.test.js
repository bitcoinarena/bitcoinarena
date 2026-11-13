// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 (refutes #1828): the publish queue is FIFO with ZAP_PUBLISH_PARALLEL (4) slots, and a slot is held for as
// long as the payer's own relays take. Four 1-sat zaps paid ahead of an honest one, each naming one silent relay, hold all four
// slots for sendToRelay's 10 s; the honest receipt is not sent to its (answering) relay until they time out. K such zaps hold it
// ceil(K/4) x 10 s - the same "a receipt waits on another zap's relays", only cheaper per second.
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

test('#1489 a45-refute-17: four silent-relay zaps ahead in the publish queue do not hold the honest receipt', async () => {
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => silent.on('listening', x));
  const seen = new Map();   // receipt id -> ms it reached the honest relay
  const good = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => good.on('listening', x));
  good.on('connection', (ws) => ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'EVENT') { seen.set(m[1].id, Date.now()); ws.send(JSON.stringify(['OK', m[1].id, true, ''])); } }));
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ allowPrivateRelays: true, /* local test relays, kanban #2454 */ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) }),
    // the zap tool's publish as tools/zap-address.mjs has it after #1828: all of a receipt's relays at once
    publish: async (receipt, relays) => { await Promise.allSettled(relays.map((r) => sendToRelay(r, [receipt]))); },
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
    for (let i = 0; i < 4; i++) await zap(stranger, [`ws://127.0.0.1:${silent.address().port}/s${i}`]);   // 4 sat in all
    const mine = await zap(honest, [`ws://127.0.0.1:${good.address().port}/`]);
    const t0 = Date.now();
    await z.watch();
    const receipt = z.receipts.find((r) => r.tags.some((t) => t[0] === 'description' && JSON.parse(t[1]).id === mine.id));
    assert.ok(receipt, 'signed');
    await new Promise((x) => setTimeout(x, 3000));
    const at = seen.get(receipt.id);
    console.log(`after 3 s the honest receipt ${at ? `reached its relay at +${at - t0} ms` : 'has NOT reached its relay (4 silent zaps hold all 4 publish slots)'}`);
    assert.ok(at, 'the honest receipt waits on the strangers\' silent relays: the 4 publish slots are all theirs for 10 s');
  } finally {
    for (const c of silent.clients) c.terminate();
    for (const c of good.clients) c.terminate();
    await new Promise((x) => silent.close(x));
    await new Promise((x) => good.close(x));
    await z.close();
  }
});
