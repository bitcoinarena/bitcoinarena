// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE BECH32 STRING UNDER ANOTHER NETWORK'S PREFIX (kanban #2642, the faucet flows): the faucet takes testnet4 only (tb1 addresses, lntb invoices),
// the devnet is regtest (bcrt1, lnbcrt). The data part - the witness program, the invoice's fields and its signature - stays byte for byte; only the
// human-readable prefix and the checksum change, so the way back gives the exact original string. bech32 and bech32m both (the checksum's own
// constant is kept). Used by the suite's RPC proxy, its lncli wrapper (e2e/bin/lncli-regtest) and the faucet's front proxy; never by product code.
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32 = 1, BECH32M = 0x2bc830a3;
function polymod(values) {
  let c = 1;
  for (const v of values) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i]; }
  return c >>> 0;
}
const expand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];

/** `str` with its prefix `from` (the hrp starts with it; `rest` must match what follows) put as `to`; the input unchanged when it is no valid bech32 of `from`. */
export function rehrp(str, from, to, { rest = /^$/ } = {}) {
  const s = String(str || '').toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) return str;
  const hrp = s.slice(0, pos);
  if (!hrp.startsWith(from) || !rest.test(hrp.slice(from.length))) return str;
  const data = [...s.slice(pos + 1)].map((c) => CH.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return str;
  const kind = polymod([...expand(hrp), ...data]);
  if (kind !== BECH32 && kind !== BECH32M) return str;
  const nh = to + hrp.slice(from.length), body = data.slice(0, -6);
  const m = polymod([...expand(nh), ...body, 0, 0, 0, 0, 0, 0]) ^ kind;
  return `${nh}1${[...body, ...[0, 1, 2, 3, 4, 5].map((i) => (m >>> (5 * (5 - i))) & 31)].map((d) => CH[d]).join('')}`;
}
const AMOUNT = /^(\d+[munp]?)?$/;
export const regtestToTestnetAddress = (a) => rehrp(a, 'bcrt', 'tb');
export const testnetToRegtestAddress = (a) => rehrp(a, 'tb', 'bcrt');
export const regtestToTestnetInvoice = (i) => rehrp(i, 'lnbcrt', 'lntb', { rest: AMOUNT });
export const testnetToRegtestInvoice = (i) => rehrp(i, 'lntb', 'lnbcrt', { rest: AMOUNT });
