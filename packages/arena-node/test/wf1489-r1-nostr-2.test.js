// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-nostr-2: ONE SIGNED ZAP REQUEST, ONE OPEN INVOICE.
// serveZapAddresses' callback mints a new Lightning invoice and a new `pending` entry (rewritten to the state file whole, looked up
// against LND every watchMs) for EVERY call - the same signed zap request replayed any number of times included, with no bound on
// pending at all. A stranger signs one kind 9734 once and replays the URL: LND's invoice database, the state file and the watcher's
// lookups (one lncli call per pending invoice every 2 s, for an hour each) grow without limit.
// Safe: a zap request already invoiced and open answers that invoice again (or is refused); pending stays bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 r1-nostr-2: a replayed zap request does not mint a new invoice and pending entry each time', async () => {
  let minted = 0;
  const invoice = async ({ amountMsat, descriptionHash }) => {
    minted++;
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const payer = keyPair(); const to = keyPair();
    const request = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), { secret: payer.secret, curve });
    const url = `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`;
    const prs = new Set();
    for (let i = 0; i < 50; i++) { const said = await (await fetch(url)).json(); assert.ok(said.pr, JSON.stringify(said)); prs.add(said.pr); }
    assert.ok(z.pending.size <= 1 && minted <= 1,
      `one signed zap request replayed 50 times: ${minted} invoices minted, ${z.pending.size} pending entries, ${prs.size} distinct invoices`);
  } finally { await z.close(); }
});
