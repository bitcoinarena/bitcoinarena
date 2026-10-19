// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SEGWIT ADDRESSES, WRITTEN AND READ (BIP173 bech32 for v0, BIP350 bech32m for v1+), for the node's wallet and the
// address an owner withdraws a bond to. The network is its human-readable part: 'tb' for testnet4 (and testnet3/signet), 'bc'
// for mainnet, 'bcrt' for regtest.
export const HRP_OF = Object.freeze({ testnet4: 'tb', mainnet: 'bc', regtest: 'bcrt' });

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;
const polymod = (values) => { let chk = 1; for (const v of values) { const top = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]; } return chk; };
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
const convert = (data, from, to, pad) => {
  let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
};
/** A segwit v1 (taproot) address of a 32-byte output key. */
export function taprootAddress(outputKey, hrp = 'tb') {
  const data = [1, ...convert([...outputKey], 8, 5, true)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  return `${hrp}1${[...data, ...[0, 1, 2, 3, 4, 5].map((i) => (chk >> (5 * (5 - i))) & 31)].map((d) => CHARSET[d]).join('')}`;
}
/** A segwit address (v0 bech32 or v1+ bech32m) to its output script; null when it is not one. */
export function addressScript(address, hrp = 'tb') {
  const a = String(address || '').trim().toLowerCase();
  const sep = a.lastIndexOf('1');
  if (a.slice(0, sep) !== hrp || a.length < 14 || a.length > 90) return null;
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return null;
  const chk = polymod([...hrpExpand(hrp), ...data]);
  const version = data[0];
  if (!((version === 0 && chk === 1) || (version > 0 && chk === BECH32M))) return null;
  const prog = convert(data.slice(1, -6), 5, 8, false);
  if (!prog || prog.length < 2 || prog.length > 40 || version > 16 || (version === 0 && prog.length !== 20 && prog.length !== 32)) return null;
  return Uint8Array.from([version ? 0x50 + version : 0, prog.length, ...prog]);
}

