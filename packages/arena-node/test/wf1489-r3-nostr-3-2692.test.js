// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r3 nostr-3 (kanban #1489): THE ZAPS A PLAYER RECEIVED COUNT ANOTHER PLAYER'S RECEIPTS.
// arena-client zap.js zapsReceived(recipient) asks each relay for {kinds:[9735], "#p":[recipient]} and hands everything that comes
// back to protocol zapTotals. relayRead checks only that a frame is on its subscription and the event is signed; zapReceiptStands
// checks the receipt's server key, its request, its invoice - and that the receipt's `p` is its REQUEST's `p` - but nobody checks
// that this `p` is the recipient that was asked for (P9: an answer taken without checking it answers THIS request). One relay of the
// list (a public relay, the payer's choice of relay, anyone who runs one) hands BOB's board the genuine, signed receipts of
// every zap ALICE got from the same Lightning address server, and BOB shows them as his own.
// Safe behaviour: a receipt whose zap request names another recipient is not counted for this one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate, zapReceiptTemplate } from '../../arena-protocol/src/zap.js';
import { signNostr } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';
import { zapsReceived } from '../../arena-client/src/zap.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('wf1489-r3-nostr-3: a receipt for ALICE handed back for BOB\'s query is not counted as BOB\'s', async () => {
  const payer = keyPair(), alice = keyPair(), bob = keyPair(), server = keyPair();
  // ONE REAL ZAP TO ALICE: the request, the invoice under its hash, the receipt the server signed once it was paid
  const request = signNostr(zapRequestTemplate({ recipient: alice.pubkey, amountMsat: 1000000n, relays: ['wss://relay.example'], comment: 'gg' }),
    { secret: payer.secret, curve });
  const description = JSON.stringify(request);
  const preimage = randomBytes(32);
  const invoice = testInvoice({ amountMsat: 1000000n, paymentHash: sha(preimage), descriptionHash: sha(description) });
  const receipt = signNostr(zapReceiptTemplate({ request, description, invoice, preimage: hex(preimage), paidAtS: 1790000100 }), { secret: server.secret, curve });
  // A RELAY that answers any receipt query with the receipts it holds, whoever they are for
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === 'REQ') { ws.send(JSON.stringify(['EVENT', m[1], receipt])); ws.send(JSON.stringify(['EOSE', m[1]])); }
  }));
  try {
    const got = await zapsReceived(bob.pubkey, { relays: [`ws://127.0.0.1:${wss.address().port}`], nostrPubkey: server.pubkey, curve, WebSocketImpl: WebSocket, timeoutMs: 3000 });
    assert.equal(got.count, 0, `BOB was credited ${got.count} zap(s), ${got.msat} msat, that were paid to ALICE (receipt p ${got.zaps.map((z) => z.recipient.slice(0, 8)).join(',')}, asked for ${bob.pubkey.slice(0, 8)})`);
    assert.equal(got.msat, 0n);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
