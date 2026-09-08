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
