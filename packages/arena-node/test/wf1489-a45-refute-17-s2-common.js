// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45-refute-17 skeptic 2: shared rig - a zap address with the tool's publish (tools/zap-address.mjs: sendToRelay, throws
// when no relay answered), relays that answer, relays that stay silent (sendToRelay's 10 s), and a payer that zaps.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr } from '../src/zap-address.js';
import { sendToRelay } from '../src/nostr-results.js';
import { testInvoice } from './bolt11-fixture.js';

export const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
export const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
export const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

export async function relay({ answer = true } = {}) {
  const w = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => w.on('listening', x));
  const seen = new Map();
  const r = { w, seen, answer, url: `ws://127.0.0.1:${w.address().port}/` };
  w.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === 'EVENT') { seen.set(m[1].id, Date.now()); if (r.answer) ws.send(JSON.stringify(['OK', m[1].id, true, ''])); }
  }));
  r.close = async () => { for (const c of w.clients) c.terminate(); await new Promise((x) => w.close(x)); };
  return r;
}

export async function address(extra = {}) {
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const logs = [];
  const server = keyPair();
  const z = await serveZapAddresses({ allowPrivateRelays: true, /* local test relays, kanban #2454 */ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) }),
    publish: async (receipt, relays) => {     // tools/zap-address.mjs's publish, as c6163b6b9 has it
      const said = await Promise.all(relays.map(async (r) => !!(await sendToRelay(r, [receipt])).get(receipt.id)));
      if (!said.some(Boolean)) throw new Error('no relay answered');
    },
    watchMs: 3600000, log: (s) => logs.push(s), ...extra });
  const to = keyPair();
  const payers = [];
  let n = 0, seq = 0;
  const zap = async (relays, payer) => {
    if (!payer) { if (n % 10 === 0) payers.push(keyPair()); payer = payers[payers.length - 1]; n++; }   // 10 open zaps per key
    const request = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays, comment: `z${++seq}` }), { secret: payer.secret, curve });
    const said = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
    assert.ok(said.pr, JSON.stringify(said));
    return request;
  };
  const receiptOf = (request) => z.receipts.find((r) => r.tags.some((t) => t[0] === 'description' && JSON.parse(t[1]).id === request.id));
  return { z, zap, logs, receiptOf };
}
export const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
