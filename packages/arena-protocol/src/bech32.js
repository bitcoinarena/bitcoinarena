// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * BECH32 (BIP-173), FOR LNURL (LUD-01).
 *
 * An LNURL is a URL written in bech32 under the human-readable part `lnurl`,
 * with no length limit. The donation set names its recipients as LNURLs
 * (§22A), and before this nothing in the repo could turn one into the URL a
 * wallet has to ask - `donation.js` only folded their case. Written out here
 * because it is sixty lines and a dependency for sixty lines is a dependency
 * that decides which address gets paid.
 *
 * CASE IS THE ENCODING'S: an all-lowercase and an all-uppercase string are the
 * same address, mixed case is not an address at all (BIP-173), folded in ASCII
 * as `canonicalLnurl` folds it.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const asciiUpper = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));

/** 5-bit words under `hrp`, with the six-word checksum. */
export function bech32Encode(hrp, words) {
  const chk = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = [];
  for (let i = 0; i < 6; i++) sum.push((chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => CHARSET[w]).join('')}`;
}

/** `{ hrp, words }` of a bech32 string, or a throw naming what is wrong. `limit` is BIP-173's 90; LNURL has none. */
export function bech32Decode(str, { limit = 90 } = {}) {
  if (typeof str !== 'string') throw new Error('a bech32 string is a string');
  if (str.length > limit) throw new Error(`a bech32 string is at most ${limit} characters`);
  for (const c of str) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error('a bech32 string is printable ASCII');
  }
  if (str !== asciiLower(str) && str !== asciiUpper(str)) throw new Error('bech32 does not allow mixed case');
  const s = asciiLower(str);
  const at = s.lastIndexOf('1');
  if (at < 1) throw new Error('a bech32 string names a human-readable part before its separator');
  if (at + 7 > s.length) throw new Error('a bech32 string ends in a six-character checksum');
  const hrp = s.slice(0, at);
  const words = [];
  for (const c of s.slice(at + 1)) {
    const w = CHARSET.indexOf(c);
    if (w < 0) throw new Error(`"${c}" is not a bech32 character`);
    words.push(w);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error('that bech32 checksum does not verify');
  return { hrp, words: words.slice(0, -6) };
}

/** Regroups bits: 8 -> 5 with padding, 5 -> 8 without (and the leftover must be zeros). */
export function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('a value is wider than its group');
    acc = ((acc << from) | v) & 0xffffff;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & max); }
  else if (bits >= from || ((acc << (to - bits)) & max)) throw new Error('bech32 data carries non-zero padding');
  return out;
}

/** The LNURL of a URL: lowercase, `lnurl` + bech32 of its UTF-8 bytes. */
export function lnurlFor(url) {
  return bech32Encode('lnurl', convertBits([...new TextEncoder().encode(String(url))], 8, 5, true));
}

/** The URL an LNURL names, or a throw: it must be bech32 under `lnurl`. */
export function urlOfLnurl(lnurl) {
  const { hrp, words } = bech32Decode(lnurl, { limit: Infinity });
  if (hrp !== 'lnurl') throw new Error(`that is bech32 under "${hrp}", not an LNURL`);
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(convertBits(words, 5, 8, false)));
}
