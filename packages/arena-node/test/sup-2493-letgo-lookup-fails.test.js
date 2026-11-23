// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-18-s2 (refutes #1619 / #2141): an evicted zap dropped past ZAP_EVICTED_MAX is removed from the
// state first, then looked up once, then cancelled. When that one lookup fails (LND busy - under exactly the flood that causes
// the drop, or restarting), the `.catch` only logs: the invoice is neither cancelled nor watched any more. The honest zapper pays
// it (still valid at LND), the sats arrive, and no NIP-57 receipt is ever signed - the #2141 effect back through the retry path.
// Safe: a zap invoice is either watched until its expiry or cancelled; a failed lookup/cancel is tried again, never forgotten.
// Adapted to 1.9 by #2536 (kanban #2493): 1.9 has no ZAP_EVICTED_MAX drop and no cancel at the drop (the #1619 / #2141 line); since #1922 a
// zap let go from a full book moves to `letGo` and is WATCHED UNTIL ITS INVOICE EXPIRES (saved with the book); with the book and the
// let-go room both full a new zap is refused. The same flood past both, the honest zap's lookups failing throughout it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_PENDING_MAX, ZAP_PENDING_PER_PAYER, ZAP_LET_GO_MAX } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#2493 (1.9) #1489 a44-refute-18-s2: a failed lookup at the drop does not leave a payable zap invoice unwatched and uncancelled', async () => {
  const byInvoice = new Map();
  const invoice = async ({ amountMsat, descriptionHash }) => {
    const paymentHash = sha(randomBytes(32));
    const request = testInvoice({ amountMsat, paymentHash, descriptionHash });
    byInvoice.set(request, hex(paymentHash));
    return { request, paymentHash: hex(paymentHash) };
  };
  const settled = new Set();
  const cancelled = new Set();
  let honestHash = null;
  let lndBusy = false;
  const server = keyPair();
  const published = [];
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice,
    lookup: async ({ paymentHash }) => {
      if (lndBusy && paymentHash === honestHash) throw new Error('lnd: connection refused');
      return settled.has(paymentHash) ? { settled: true, preimage: null, settledAtS: Math.floor(Date.now() / 1000) } : { settled: false };
    },
    cancel: async ({ paymentHash }) => { if (settled.has(paymentHash)) throw new Error('already settled'); cancelled.add(paymentHash); },
    publish: async (r) => { published.push(r); }, watchMs: 3600000 });
  const ask = async (payer, to, n) => {
    const request = signNostr(zapRequestTemplate({ recipient: to, amountMsat: 1000n, relays: ['wss://relay.example'], comment: `n${n}` }), { secret: payer.secret, curve });
    return (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
  };
  try {
    const to = keyPair().pubkey;
    const honest = await ask(keyPair(), to, 'honest');
    assert.ok(honest.pr, JSON.stringify(honest));
    honestHash = byInvoice.get(honest.pr);
    lndBusy = true;                          // LND answers the honest hash's lookup with an error during the flood
    let n = 0, taken = 0, refusedN = 0;
    for (let k = 0; k < (ZAP_PENDING_MAX + ZAP_LET_GO_MAX) / ZAP_PENDING_PER_PAYER + 1; k++) {
      const stranger = keyPair();
      const asks = [];
      for (let i = 0; i < ZAP_PENDING_PER_PAYER; i++) asks.push(ask(stranger, to, n++));
      for (const said of await Promise.all(asks)) { if (said.pr) taken++; else refusedN++; }
    }
    console.log('  FLOOD:', JSON.stringify({ taken, refused: refusedN, pending: z.pending.size, letGo: z.letGo.size, honestLetGo: z.letGo.has(honestHash), honestPending: z.pending.has(honestHash) }));
    assert.ok(z.pending.has(honestHash) || z.letGo.has(honestHash), 'the honest zap is still watched after the flood');
    await new Promise((r) => setTimeout(r, 100));
    lndBusy = false;
    if (!cancelled.has(honestHash)) {
      settled.add(honestHash);               // not cancelled: still payable at LND, and the honest zapper pays it
      for (let i = 0; i < 100; i++) await z.watch();   // every watch pass a seat would run for a few minutes
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(published.some((r) => r.tags.some(([t, v]) => t === 'bolt11' && v === honest.pr)),
        `the honest zap invoice was neither cancelled nor watched: paid, and no receipt (pending ${z.pending.has(honestHash)}, let go ${z.letGo.has(honestHash)})`);
    }
  } finally { await z.close(); }
});
