// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET THE COMMITTEE SPENDS FROM, AND NOTHING ELSE CAN.
//
// 23.5: "Settled loser stakes accumulate in a wallet whose every operation
// requires a 5-of-7 threshold signature of the settlement committee. No node
// and no minority can move a satoshi, at any moment, including during payout."
//
// Measured before this file existed: there was no wallet at all. `payout.js`
// named one in three comments, nothing in any source file held one, and a
// settled stake ended up in the channel balance of whichever Lightning node
// `lndPort` was pointed at - spendable by one macaroon. Item 10 built a
// threshold signature that nothing called.
//
// THE POOL IS A KEY, NOT AN OBJECT. One P2TR output whose key is the
// committee's FROST group key, and the only way to move it is a signature five
// of seven produced. There is deliberately NO SCRIPT PATH: 23.5 says EVERY
// operation needs the threshold, and a leaf is a second way in - a recovery
// path, a timeout, an operator's key - that would make that sentence false.
//
// SO THE TWEAK COMMITS TO NOTHING, which is BIP-341's own instruction for an
// output with no scripts: Q = P + H_TapTweak(P)*G with an empty merkle root.
// Skipping the tweak would also spend, but it would publish a raw group key as
// an output and every taproot reader would ask what tree it was hiding.
//
// WHAT A SIGNER HAS TO DO ABOUT THAT, and it is two additions and no new
// protocol: adding the SAME constant to every share adds it to the secret,
// because the interpolating values over any signing set sum to one. So each
// signer node adds the tweak to its own share and knows nothing more than it did.
import { taggedHash } from './hash.js';
import { FIELD } from './shares.js';

/** OP_1 <32-byte key>: the whole of a P2TR script pubkey. */
export const P2TR_SCRIPT_BYTES = 34;

const mod = (n) => ((n % FIELD) + FIELD) % FIELD;
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** BIP-341's tweak for an output with no script tree: the key, and nothing after it. */
export const poolTweak = (internalKeyX) => taggedHash('TapTweak', internalKeyX);

/**
 * THE OUTPUT KEY AND THE SCRIPT THAT PAYS TO IT.
 *
 * `groupPublicKey` is the 33-byte compressed FROST group key, which item 10
 * already normalises to even y when it is dealt. `tweakPoint` is the curve's,
 * the same one the bonds use, and it hands back the parity a signer needs.
 */
export function poolOutput({ groupPublicKey, curve }) {
  if (!(groupPublicKey instanceof Uint8Array) || groupPublicKey.length !== 33)
    return { ok: false, why: 'a group key is a 33-byte compressed point' };
  if (groupPublicKey[0] !== 0x02)
    return { ok: false, why: 'that group key has odd y: normalise it when it is dealt' };
  if (typeof curve.tweakPoint !== 'function')
    return { ok: false, why: 'building a pool output needs a curve, and none was injected' };

  const internal = groupPublicKey.subarray(1);
  const tweak = poolTweak(internal);
  const { outputKey, parity } = curve.tweakPoint(internal, tweak);
  return {
    ok: true,
    internalKey: internal,
    tweak,
    outputKey,
    // Whether Q came out with odd y. Every signer needs it and it is public.
    negated: parity === 1,
    script: cat(Uint8Array.from([0x51, 0x20]), outputKey),
  };
}

/**
 * ONE SIGNER NODE'S SHARE, MOVED ONTO THE OUTPUT KEY.
 *
 * Adding the tweak to every share adds it to the secret, and negating every
 * share negates the secret - both because the interpolating values sum to one
 * over any signing set. A signer node that got either wrong produces a signature that
 * verifies against nothing, which a node reports as a bad signature and not as
 * a bad share, so it is worth doing in one place.
 */
export function poolShare({ share, tweak, negated }) {
  if (typeof share !== 'bigint') throw new Error('a share is a scalar');
  const shifted = mod(share + (tweak instanceof Uint8Array
    ? mod(BigInt('0x' + [...tweak].map((b) => b.toString(16).padStart(2, '0')).join('')))
    : mod(tweak)));
  return negated ? mod(FIELD - shifted) : shifted;
}

/** The compressed, even-y form of the output key, which is what FROST signs under. */
export const poolSigningKey = (outputKey) => cat(Uint8Array.from([0x02]), outputKey);

/**
 * THE WITNESS OF A KEY-PATH SPEND: one item, the signature, and nothing else.
 *
 * No script, no control block, no annex. That shortness is the property - a
 * witness with a second item is a spend that took another way in.
 */
export function poolWitness(signature) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64)
    throw new Error('a BIP-340 signature is 64 bytes, and a key-path witness is only that');
  return [signature];
}

/** Is this output one the committee can move? Asked of bytes off a chain. */
export function poolOwns(script, outputKey) {
  if (!(script instanceof Uint8Array) || script.length !== P2TR_SCRIPT_BYTES)
    return { ok: false, why: 'that is not a P2TR output' };
  if (script[0] !== 0x51 || script[1] !== 0x20)
    return { ok: false, why: 'that is not a version-1 witness program of 32 bytes' };
  for (let i = 0; i < 32; i++)
    if (script[2 + i] !== outputKey[i])
      return { ok: false, why: 'that output pays a different key than this pool' };
  return { ok: true, why: 'that output is the pool\'s' };
}

/**
 * THE PUBLIC SIDE OF `poolShare`: a signer node's public share moved onto the output
 * key the same way its secret share is - plus tG, negated for an odd output
 * key. What a payout checks one signer's signature share against.
 */
export function poolPublicShare({ publicShare, tweak, negated, curve }) {
  const t = tweak instanceof Uint8Array
    ? mod(BigInt('0x' + [...tweak].map((b) => b.toString(16).padStart(2, '0')).join('')))
    : mod(tweak);
  const moved = curve.combinePoints([{ point: publicShare, coefficient: 1n }, { point: curve.pointFromScalar(t), coefficient: 1n }]);
  return negated ? curve.combinePoints([{ point: moved, coefficient: FIELD - 1n }]) : moved;
}
