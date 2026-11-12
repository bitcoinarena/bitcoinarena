// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2249 #2261 (#1489 a45-refute-17): a receipt still owed a send is kept in the state file and sent after a restart; a send that
// throws is tried again on its backoff, not dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#2249 a receipt no relay took yet survives a restart and is sent then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zap-owed-'));
  const statePath = join(dir, 'state.json');
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair(); const to = keyPair(); const payer = keyPair();
  const base = { port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice, statePath, watchMs: 3600000,
    lookup: async () => ({ settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) }) };
  let tries = 0;
  const z = await serveZapAddresses({ ...base, publish: async () => { tries++; throw new Error('no relay answered'); } });
  const request = signNostr(zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://a.example', 'wss://b.example'] }), { secret: payer.secret, curve });
  const said = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
  assert.ok(said.pr, JSON.stringify(said));
  await z.watch();
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(tries, 2, 'one send per relay');
  assert.equal(z.pending.size, 0);
  await z.close();
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.owed.length, 1, 'the receipt is still owed');
  assert.deepEqual(st.owed[0].relays.sort(), ['wss://a.example', 'wss://b.example']);
  const sent = [];
  const z2 = await serveZapAddresses({ ...base, publish: async (e, relays) => { sent.push([e.id, ...relays]); } });
  await new Promise((x) => setTimeout(x, 50));
  assert.deepEqual(sent.map((s) => s[1]).sort(), ['wss://a.example', 'wss://b.example']);
  assert.equal(sent[0][0], st.owed[0].receipt.id);
  assert.equal(z2.receipts.length, 1);
  await z2.close();
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).owed.length, 0, 'nothing owed once both relays took it');
});
