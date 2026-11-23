// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { serveZapAddresses, signNostr, ZAP_MINTS_PER_ASKER, ZAP_MINTS_ALL, ZAP_PENDING_MAX, ZAP_LET_GO_MAX, ZAP_PENDING_PER_PAYER } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const minter = (st) => async ({ amountMsat, descriptionHash }) => {
  st.minted++;
  const paymentHash = sha(randomBytes(32));
  return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: hex(paymentHash) };
};

// kanban #1489 v1-refute-19-s3 (#1514, #1743, #1964): the mint bounds exempt "this host's own tools", and askerAddress (a second
// copy of the asker logic, reused from reach-check.js) takes the asker from cf-connecting-ip / the FIRST X-Forwarded-For hop whenever
// the socket peer is 127.0.0.1 - which every request through the local proxy is. A proxy that appends to X-Forwarded-For
// (tailscale serve, nginx $proxy_add_x_forwarded_for) keeps the stranger's own first hop, and a path that does not overwrite
// cf-connecting-ip passes his header as it is. The stranger names 127.0.0.1 and is not counted at all: no per-asker, no global bound.
test('#1489 v1-refute-19-s3-1: a stranger who names 127.0.0.1 in X-Forwarded-For is still bounded', async () => {
  const st = { minted: 0 };
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: keyPair().secret, curve, invoice: minter(st),
    lookup: async () => ({ settled: false }), publish: async () => {}, watchMs: 3600000 });
  try {
    const n = ZAP_MINTS_PER_ASKER * 4;
    for (let i = 0; i < n; i++) {
      // the stranger sends "X-Forwarded-For: 127.0.0.1"; the proxy appends the address it saw (203.0.113.9)
      await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${1000 + i}`, { headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' } })).json();
    }
    assert.ok(st.minted <= ZAP_MINTS_PER_ASKER, `one stranger minted ${st.minted} invoices in one window (bound ${ZAP_MINTS_PER_ASKER} per asker, ${ZAP_MINTS_ALL} in all)`);
  } finally { await z.close(); }
});
