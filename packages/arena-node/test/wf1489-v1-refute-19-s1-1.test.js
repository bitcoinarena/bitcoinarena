// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-19 (#1514): the per-payer cap counts only `pending`, not `minting`. One key sends 50 DIFFERENT signed zap
// requests at once while LND is slow: each passes the per-payer check (none of them is pending yet) -> 50 open zaps from one key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_PER_PAYER } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 v1-refute-19-s1-1: concurrent distinct zap requests from one key stay under ZAP_PENDING_PER_PAYER', async () => {
  let minted = 0;
  const invoice = async ({ amountMsat, descriptionHash }) => {
    minted++;
    await new Promise((r) => setTimeout(r, 300));           // lncli addinvoice takes a moment
    const paymentHash = sha(randomBytes(32));
    return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
  };
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const payer = keyPair(); const to = keyPair();
    const urls = Array.from({ length: 50 }, (_, i) => {
      const request = signNostr({ ...zapRequestTemplate({ recipient: to.pubkey, amountMsat: 1000n, relays: ['wss://relay.example'] }), content: `n${i}` }, { secret: payer.secret, curve });
      return `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`;
    });
    await Promise.all(urls.map(async (u) => (await fetch(u)).json()));
    assert.ok(z.pending.size <= ZAP_PENDING_PER_PAYER,
      `one payer key, 50 concurrent distinct requests: ${minted} invoices minted, ${z.pending.size} pending (cap ${ZAP_PENDING_PER_PAYER})`);
  } finally { await z.close(); }
});
