// THE CREATOR DOES NOT GET TO PICK THE CUSTODIAN.
//
// Section 23.6 (v4.6.2, P3): "The Round Contract names `federation_id`, and a
// creator could name a federation whose guardians are all his - then §22's
// guardian residual is not a residual but the design. A federation is therefore
// valid for a paying round only if at least its own threshold of guardians are
// DISTINCT BONDED CENSUS NODES at census_height, each advertising that guardian
// peer key under guardian_of[] (§5A.1) with a bond at or above the bracket's
// bond_min_settlement, so a guardian who colludes is slashable like any seat."
//
// This is that count, over the census the client already derived from Bitcoin.
// The other two conditions are not here: that the config the client fetched
// from the guardians hashes to `federation_id` is the stock federation client's
// hashing, and the known-good list or explicit confirmation is the page's.
import { toHex } from './hash.js';
import { GUARDIAN_KEY_BYTES } from './advert.js';

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const isKey = (b) => b instanceof Uint8Array && b.length === GUARDIAN_KEY_BYTES;

/**
 * `guardianKeys` are the broadcast keys in the federation's own config and
 * `threshold` its own consensus threshold - facts about the federation the
 * client fetched, not numbers the round's creator chose. `bondMinSats` is the
 * round's. Each guardian key is counted once, for one census node, and a node
 * vouches for one guardian: two keys advertised by one node are one operator.
 */
export function federationIsBonded({ federationId, guardianKeys, threshold, census, bondMinSats } = {}) {
  if (!is32(federationId) || federationId.every((b) => b === 0))
    return { ok: false, why: 'that round names no federation' };
  if (!Array.isArray(guardianKeys) || !guardianKeys.length || !guardianKeys.every(isKey))
    return { ok: false, why: 'that federation\'s config names no 33-byte guardian keys' };
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > guardianKeys.length)
    return { ok: false, why: 'that federation\'s config names no usable threshold' };
  if (typeof bondMinSats !== 'bigint') return { ok: false, why: 'the round names no minimum bond' };
  if (!Array.isArray(census)) return { ok: false, why: 'there is no census to find the guardians in' };

  const wanted = new Set(guardianKeys.map(toHex));
  const fid = toHex(federationId);
  const keysTaken = new Set();
  const nodesTaken = new Set();
  for (const e of census) {
    if (!e || !e.advert || !Array.isArray(e.advert.guardianOf)) continue;
    if (typeof e.bondSats !== 'bigint' || e.bondSats < bondMinSats) continue;
    const node = toHex(e.pubkey || e.advert.nodePubkey);
    if (nodesTaken.has(node)) continue;
    for (const g of e.advert.guardianOf) {
      const key = toHex(g.guardianKey);
      if (toHex(g.federationId) !== fid || !wanted.has(key) || keysTaken.has(key)) continue;
      keysTaken.add(key);
      nodesTaken.add(node);
      break;
    }
  }

  if (keysTaken.size < threshold)
    return {
      ok: false, bonded: keysTaken.size, threshold,
      why: `${keysTaken.size} of that federation's ${guardianKeys.length} guardians are bonded census `
        + `nodes, and its threshold is ${threshold}: a creator could hold it alone`,
    };
  return { ok: true, bonded: keysTaken.size, threshold };
}
