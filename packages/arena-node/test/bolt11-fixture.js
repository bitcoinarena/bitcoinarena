// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOLT11 INVOICE FOR A TEST, built from the fields `decodeBolt11` reads - prefix and amount, a timestamp, the
// payment hash (p), the description hash (h) - and a signature-sized tail of zeros. Test code only: no product path
// mints an invoice, and no signature is claimed (decodeBolt11 does not check one, and nothing here pays it).
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';

const words = (bytes) => convertBits([...bytes], 8, 5, true);
const tagged = (type, bytes) => { const w = words(bytes); return [type, Math.floor(w.length / 32), w.length % 32, ...w]; };

export function testInvoice({ amountMsat, paymentHash, descriptionHash, network = 'bcrt', timestamp = 1790000000 }) {
  const hrp = `ln${network}${BigInt(amountMsat) * 10n}p`;
  const ts = [];
  for (let i = 6, t = timestamp; i >= 0; i--) { ts[i] = t % 32; t = Math.floor(t / 32); }
  const data = [...ts, ...tagged(1, paymentHash), ...(descriptionHash ? tagged(23, descriptionHash) : []), ...new Array(104).fill(0)];
  return bech32Encode(hrp, data);
}
