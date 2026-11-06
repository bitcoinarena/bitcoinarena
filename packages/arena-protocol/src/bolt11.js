// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A BOLT11 INVOICE, READ (M3.2 item 6e): the network, the amount, the payment
 * hash, the description and the description hash - what a donor's page must
 * check before its wallet pays an invoice a recipient's LNURL endpoint handed
 * it (LUD-06: the amount is the one asked, the description hash is the
 * endpoint's own metadata). `decodeBolt11` does not check the node's
 * signature: the wallet that pays does that. WHO IS PAID is `invoicePayee`
 * (kanban #1154): the key the signature recovers to, with the curve the caller
 * brings - this package carries none.
 *
 * Tested against the examples BOLT11 itself publishes.
 */
import { bech32Decode, convertBits } from './bech32.js';
import { sha256, toHex } from './hash.js';

const NETWORKS = { bc: 'bitcoin', tb: 'testnet', tbs: 'signet', bcrt: 'regtest', sb: 'simnet' };
const MSAT_PER_UNIT = { m: 100000000n, u: 100000n, n: 100n };     // p: a tenth of a msat, below
const TAG_PAYMENT_HASH = 1;        // 'p'
const TAG_DESCRIPTION = 13;        // 'd'
const TAG_DESCRIPTION_HASH = 23;   // 'h'
const TAG_PAYEE = 19;              // 'n'
const SIGNATURE_WORDS = 104;       // 65 bytes

/** The amount a BOLT11 prefix names, in msat, or null for "any amount". */
export function hrpAmountMsat(hrp) {
  const m = String(hrp).match(/^ln(bcrt|bc|tbs|tb|sb)(\d*)([munp]?)$/);
  if (!m) throw new Error(`"${hrp}" is not a BOLT11 prefix`);
  if (!m[2]) {
    if (m[3]) throw new Error('an amount multiplier with no amount');
    return null;
  }
  if (m[2].length > 1 && m[2][0] === '0') throw new Error('a BOLT11 amount has no leading zero');
  const n = BigInt(m[2]);
  if (!m[3]) return n * 100000000000n;
  if (m[3] === 'p') {
    // BOLT11: "if the `p` multiplier is used the last decimal of `amount` MUST be `0`"
    if (n % 10n !== 0n) throw new Error('a pico amount must end in 0: there is no tenth of a millisatoshi');
    return n / 10n;
  }
  return n * MSAT_PER_UNIT[m[3]];
}

const bytesOf = (words) => Uint8Array.from(convertBits(words, 5, 8, false));

export function decodeBolt11(invoice) {
  const { hrp, words } = bech32Decode(String(invoice).trim(), { limit: Infinity });
  const network = NETWORKS[(hrp.match(/^ln(bcrt|bc|tbs|tb|sb)/) || [])[1]];
  const amountMsat = hrpAmountMsat(hrp);
  if (words.length < 7 + SIGNATURE_WORDS) throw new Error('that invoice is too short to carry a timestamp and a signature');
  const data = words.slice(0, words.length - SIGNATURE_WORDS);
  let timestamp = 0;
  for (let i = 0; i < 7; i++) timestamp = timestamp * 32 + data[i];
  let paymentHash = null;
  let descriptionHash = null;
  let description = null;
  let payee = null;
  for (let at = 7; at < data.length;) {
    if (at + 3 > data.length) throw new Error('a tagged field is cut short');
    const type = data[at];
    const len = data[at + 1] * 32 + data[at + 2];
    at += 3;
    if (at + len > data.length) throw new Error('a tagged field runs past the invoice');
    const field = data.slice(at, at + len);
    at += len;
    // BOLT11: a reader MUST skip a p or h field whose length is not 52 words.
    if (type === TAG_PAYMENT_HASH && len === 52 && !paymentHash) paymentHash = bytesOf(field);
    else if (type === TAG_DESCRIPTION_HASH && len === 52 && !descriptionHash) descriptionHash = bytesOf(field);
    else if (type === TAG_DESCRIPTION && description === null) description = new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(field));
    // BOLT11: a reader MUST skip an n field whose length is not 53 words
    else if (type === TAG_PAYEE && len === 53 && !payee) payee = bytesOf(field);
  }
  if (!paymentHash) throw new Error('that invoice names no payment hash');
  return { network, amountMsat, timestamp, paymentHash, descriptionHash, description, payee };
}

/**
 * WHAT A BOLT11 INVOICE'S NODE SIGNED (BOLT11 "signature"): sha256 of the human-readable part's UTF-8 bytes and the data part without
 * the signature, zero-padded to a byte; with the 64-byte signature and its recovery id, as the invoice carries them.
 */
export function bolt11SignedDigest(invoice) {
  const { hrp, words } = bech32Decode(String(invoice).trim(), { limit: Infinity });
  if (words.length < 7 + SIGNATURE_WORDS) throw new Error('that invoice is too short to carry a timestamp and a signature');
  const data = words.slice(0, words.length - SIGNATURE_WORDS);
  const sig = bytesOf(words.slice(words.length - SIGNATURE_WORDS));
  const hrpBytes = new TextEncoder().encode(hrp);
  const body = Uint8Array.from(convertBits(data, 5, 8, true));
  const msg = new Uint8Array(hrpBytes.length + body.length);
  msg.set(hrpBytes, 0); msg.set(body, hrpBytes.length);
  return { digest: sha256(msg), signature: sig.subarray(0, 64), recovery: sig[64] };
}

/**
 * WHO A BOLT11 INVOICE PAYS (kanban #1154): the 33-byte node key its signature recovers to, hex - and, where the invoice names its payee
 * (the n field), only if that is the key that signed. `recover(sig64, bit, digest)` is the caller's curve (arena-node curve.js
 * `messageCurve.recover`). Throws on an invoice whose signature recovers to no key or to another than it names.
 */
export function invoicePayee(invoice, recover) {
  if (typeof recover !== 'function') throw new Error('no curve to recover an invoice\'s payee with');
  const { digest, signature, recovery } = bolt11SignedDigest(invoice);
  if (recovery > 3) throw new Error('that invoice\'s signature carries no recovery id');
  let key;
  try { key = recover(signature, recovery, digest); } catch (e) { throw new Error(`that invoice's signature recovers to no key: ${e.message}`); }
  const named = decodeBolt11(invoice).payee;
  if (named && toHex(named) !== toHex(key)) throw new Error('that invoice names a payee that did not sign it');
  return toHex(key);
}
