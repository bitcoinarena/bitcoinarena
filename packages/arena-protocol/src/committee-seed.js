// THE COMMITTEE SEED, ALONE IN ITS MODULE (#23, 2026-10-04): the round's shared world (seed.js) is H(committee_seed ||
// "world") (§5A.5), so seed.js needs this one formula - and beacon.js, which also reads the chain and the genesis, is not a
// module the page's bundle may carry. Both import it from here; there is one copy.
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

const catSeedParts = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const isSeedPart32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * THE SEED, EXACTLY AS 5A.5 WRITES IT.
 *
 * Four 32-byte inputs in that order and nothing else. The order is not a
 * detail: two nodes concatenating differently would select different
 * committees from identical facts, which is the one thing a committee cannot
 * survive.
 */
export function committeeSeedFrom({
  censusRootGameVerify, censusRootSettlement, roundId, roundRandomness,
}) {
  for (const [name, value] of [
    ['the game/verify census root', censusRootGameVerify],
    ['the settlement census root', censusRootSettlement],
    ['the round id', roundId],
    ['the round randomness', roundRandomness],
  ]) if (!isSeedPart32(value)) throw new TypeError(`${name} is not 32 bytes`);

  return taggedHash(TAG.committeeSeed,
    catSeedParts(censusRootGameVerify, censusRootSettlement, roundId, roundRandomness));
}

