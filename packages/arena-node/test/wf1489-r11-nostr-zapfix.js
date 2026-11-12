// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Shared stand-ins for the wf1489 r11 nostr zap tests (kanban #1489): a fake Lightning node and BIP-340 helpers.
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { testInvoice } from './bolt11-fixture.js';

export const hex = (b) => Buffer.from(b).toString('hex');
export const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
export const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
export const keyPair = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
export function fakeLightning() {
  const made = new Map();
  return {
    made,
    invoice: async ({ amountMsat, descriptionHash }) => {
      const preimage = randomBytes(32);
      const paymentHash = sha(preimage);
      const request = testInvoice({ amountMsat, paymentHash, descriptionHash });
      made.set(hex(paymentHash), { request, preimage: hex(preimage), settled: false });
      return { request, paymentHash: hex(paymentHash) };
    },
    lookup: async ({ paymentHash }) => { const m = made.get(paymentHash); return { settled: !!(m && m.settled), preimage: m && m.preimage, settledAtS: 1790000100 }; },
    payByRequest(request) { for (const m of made.values()) if (m.request === request) { m.settled = true; return m.preimage; } return null; },
  };
}
