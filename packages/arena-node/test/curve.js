// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CURVE THE PROTOCOL PACKAGE REFUSES TO CARRY.
//
// `packages/protocol` does the hashing and refuses the one point addition,
// because every other package reads it. Since letter 15 slice 2 the COMPOSED
// census refuses to return a root without that addition - a root with the
// 5A.3B template unchecked is a census over outputs nobody proved were bonds -
// so every test that derives a census lives here, where a curve exists.
//
// This file is the caller that brings one. It is not a test; `node --test`
// only picks up `*.test.js`.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import {
  bondOutputKey, bondInternalKey, BOND_SCRIPT_TEMPLATE_VERSION,
} from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const big = (b) => BigInt('0x' + toHex(b));

/** BIP-341: Q = P + t*G, with the parity that a control block has to carry. */
export const tweakPoint = (internalKey, tweak) => {
  const P = schnorr.utils.lift_x(big(internalKey));
  const Q = P.add(secp256k1.Point.BASE.multiply(big(tweak)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};

/** BIP-327's sum: Q = sum a_i * P_i, each key lifted from x-only. */
export const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const point = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? point : sum.add(point);
  }
  return schnorr.utils.pointToBytes(sum);
};

export const genesis = genesisFor('regtest');

/** What a caller hands the census so the template can be checked at all. */
export const BOND = {
  arbitrationKeys: genesis.arbitrationKeys,
  arbitrationK: genesis.arbitrationK,
  bondMaturity: genesis.bondMaturity,
  tweakPoint,
  combine,
};

// A REAL KEY PER FIXTURE NUMBER. The old fixtures used 0x1111... as a node
// key, which is fine while nobody rebuilds an output from it and useless the
// moment somebody does. Derived from the number so a rerun gets the same
// census and the same root.
const keys = new Map();
export const keyFor = (n) => {
  if (!keys.has(n)) keys.set(n, schnorr.getPublicKey(new Uint8Array(32).fill(n)));
  return keys.get(n);
};

/** The output key genesis says a node's bond must pay to. */
export const bondFor = (nodeKey, { maturity = genesis.bondMaturity, set = genesis.arbitrationKeys } = {}) =>
  bondOutputKey({
    nodeKey, arbitrationKeys: set, arbitrationK: genesis.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: set }, { combine }).internalKey,
  }, { tweakPoint, combine }).outputKey;

export { BOND_SCRIPT_TEMPLATE_VERSION };
