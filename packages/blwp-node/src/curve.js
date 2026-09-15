// THE CURVE THE DAEMON BRINGS TO THE CENSUS.
//
// `packages/protocol` carries no curve on purpose - every other package reads
// it - so it does the hashing and refuses the one point addition. Since letter
// 26's ruling that is not optional for a node: a census root cannot be
// published with the 5A.3B template unchecked, so a daemon that wants a census
// has to bring `tweakPoint` and `combine`.
//
// This is that caller. It holds no policy: the arbitration set, the threshold
// and the maturity are read straight off genesis, which is where letter 24
// put them, so nothing here can quietly hold a round against a set of its own.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { toHex } from '../../protocol/src/hash.js';

const big = (b) => BigInt('0x' + toHex(b));

/** BIP-341: Q = P + t*G, with the y-parity a control block has to carry. */
export const tweakPoint = (internalKey, tweak) => {
  const P = schnorr.utils.lift_x(big(internalKey));
  const Q = P.add(secp256k1.Point.BASE.multiply(big(tweak)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};

/** BIP-327's sum: Q = sum a_i * P_i, each key lifted from its x-only form. */
export const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const point = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? point : sum.add(point);
  }
  return schnorr.utils.pointToBytes(sum);
};

/**
 * WHAT A CENSUS OF THIS NETWORK IS CHECKED AGAINST, off genesis and nowhere
 * else. `resolveCensus` compares these against genesis itself and refuses a
 * set that is not the network's, so passing anything else would be refused
 * rather than believed - this only saves the node from being refused.
 */
export function bondSetFor(network) {
  const g = genesisFor(network);
  return {
    arbitrationKeys: g.arbitrationKeys,
    arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity,
    tweakPoint,
    combine,
  };
}

/**
 * THE GROUP A FELDMAN COMMITMENT LIVES IN, which is this same curve.
 *
 * 23.1 wants shares whose consistency a node can confirm "without
 * reconstructing P", and that needs commitments in a group where the discrete
 * log is hard: publish g^a for each coefficient and a signer node can check its share
 * lies on that polynomial while learning nothing about the constant term.
 *
 * secp256k1 and not a second group, for the same reason the node's identity
 * moved onto it: one curve is one thing to audit. The points are COMPRESSED,
 * 33 bytes, because a Feldman check needs the whole point - an x-only key
 * throws away the sign, and g^s = product only holds up to that sign, which is
 * exactly the check being made.
 */
export const pointFromScalar = (scalar) => {
  const k = typeof scalar === 'bigint' ? scalar : big(scalar);
  // ZERO HAS NO POINT ON THIS CURVE and the caller must not be handed one that
  // looks like it does. A zero coefficient is legal in a polynomial, so this
  // is a real case rather than a defensive line: the identity is written as
  // the 33 zero bytes, which is not a valid encoding of any point, so nothing
  // can mistake it for one.
  if (k % secp256k1.Point.Fn.ORDER === 0n) return new Uint8Array(33);
  return secp256k1.Point.BASE.multiply(k % secp256k1.Point.Fn.ORDER).toBytes(true);
};

/** Sum of coefficient * point, in the same encoding, for the same reason. */
export const combinePoints = (terms) => {
  let sum = null;
  for (const { point, coefficient } of terms) {
    const k = (typeof coefficient === 'bigint' ? coefficient : big(coefficient))
      % secp256k1.Point.Fn.ORDER;
    if (k === 0n) continue;                       // 0 * anything is the identity
    if (point.length === 33 && point.every((b) => b === 0)) continue;   // identity * k
    const p = secp256k1.Point.fromBytes(point).multiply(k);
    sum = sum === null ? p : sum.add(p);
  }
  return sum === null ? new Uint8Array(33) : sum.toBytes(true);
};

/**
 * THE SHARED SECRET A SHARE IS SEALED UNDER, on the same curve as everything
 * else. 23.1 wants one share encrypted to each committee member, and the
 * members are already named by their BIP-340 x-only keys - so the agreement is
 * between those keys and no second identity has to exist.
 *
 * NO EVEN-Y NORMALISATION, AND THAT WAS MEASURED RATHER THAN ASSUMED. The
 * first version negated a secret whose own point has odd y, the way BIP-340
 * signing does, on the argument that x-only keys name the even-y point. A
 * mutant that deleted the negation survived every test - because x(kP) equals
 * x(-kP) on 20 of 20 random pairs, which is the whole reason an x-only
 * agreement works at all. Both ends read the same x whether or not either
 * scalar was flipped, so the normalisation was ceremony, and ceremony in the
 * middle of a key agreement is a thing a reader has to disprove.
 */
/** The x-only public key of a secret, which is what a signer node is named by. */
export const pointX = (secret) => schnorr.getPublicKey(secret);

export const ecdhShared = (secret, theirXOnly) => {
  const n = secp256k1.Point.Fn.ORDER;
  const d = (typeof secret === 'bigint' ? secret : big(secret)) % n;
  if (d === 0n) throw new Error('zero is not a secret key');
  const x = schnorr.utils.lift_x(big(theirXOnly)).multiply(d).toAffine().x
    .toString(16).padStart(64, '0');
  return Uint8Array.from(x.match(/../g).map((h) => parseInt(h, 16)));
};

/** What `splitSecret` and `shareOpensTo` are handed when a node checks a handout. */
export const feldmanGroup = { pointFromScalar, combinePoints, ecdhShared, pointX };
