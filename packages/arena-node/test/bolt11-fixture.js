// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOLT11 INVOICE FOR A TEST, built from the fields `decodeBolt11` reads - prefix and amount, a timestamp, the
// payment hash (p), the description hash (h) - and SIGNED as BOLT11 says, by `secret` (kanban #1154: a seat now checks who an
// invoice pays, the key its signature recovers to). By default every test invoice is signed by one test recipient's node key,
// so a test address answers every seat with invoices of one payee, as a real one does. Test code only: nothing here pays it.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
import { sha256 } from '../../arena-protocol/src/hash.js';

const words = (bytes) => convertBits([...bytes], 8, 5, true);
const tagged = (type, bytes) => { const w = words(bytes); return [type, Math.floor(w.length / 32), w.length % 32, ...w]; };

/** The test recipient's Lightning node key: what every test address's invoices are signed by unless a test names another. */
export const TEST_PAYEE_SECRET = new Uint8Array(32).fill(0x5e);
export const payeeKeyOf = (secret) => secp256k1.getPublicKey(secret, true);

export function testInvoice({ amountMsat, paymentHash, descriptionHash, network = 'bcrt', timestamp = 1790000000, secret = TEST_PAYEE_SECRET }) {
  const hrp = `ln${network}${BigInt(amountMsat) * 10n}p`;
  const ts = [];
  for (let i = 6, t = timestamp; i >= 0; i--) { ts[i] = t % 32; t = Math.floor(t / 32); }
  const data = [...ts, ...tagged(1, paymentHash), ...(descriptionHash ? tagged(23, descriptionHash) : [])];
  const hrpBytes = new TextEncoder().encode(hrp);
  const body = Uint8Array.from(convertBits(data, 5, 8, true));
  const msg = new Uint8Array(hrpBytes.length + body.length);
  msg.set(hrpBytes, 0); msg.set(body, hrpBytes.length);
  // noble's recovered form is recovery id || r || s; BOLT11 carries r || s || recovery id
  const rec = secp256k1.sign(sha256(msg), secret, { prehash: false, format: 'recovered' });
  const sig = new Uint8Array(65); sig.set(rec.subarray(1), 0); sig[64] = rec[0];
  return bech32Encode(hrp, [...data, ...words(sig)]);
}
