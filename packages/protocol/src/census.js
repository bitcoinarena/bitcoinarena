// The census: which bonds exist at a height, canonicalised and Merkle-rooted.
//
// Two decisions here are load-bearing and both look like details.

import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { TAG, ROLES } from './constants.js';

/**
 * One census entry, encoded.
 *
 * The outpoint leads because it is what the entry is sorted and identified by.
 */
export function encodeEntry(e) {
  const w = new Writer();
  w.bytes32(e.txid);
  w.u32(e.vout);
  w.bytes32(e.pubkey);
  w.u64(e.bondSats);
  w.u32(e.height);
  w.vec([...e.roles].sort(), (r, ww) => ww.u8(ROLES.indexOf(r)),
        { sortedBy: (a, b) => (a < b ? -1 : a > b ? 1 : 0) });
  return w.finish();
}

export const leafHash = (e) => taggedHash(TAG.censusLeaf, encodeEntry(e));

/**
 * Compare two entries by (txid, vout).
 *
 * NOT by H(pubkey), which earlier drafts specified and which looks equivalent.
 * It is not: a node can grind a pubkey until its hash lands wherever it likes,
 * and the census order feeds the committee seed. A txid cannot be chosen after
 * the funding transaction is confirmed.
 */
export function compareEntries(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a.txid[i] !== b.txid[i]) return a.txid[i] < b.txid[i] ? -1 : 1;
  }
  return a.vout === b.vout ? 0 : a.vout < b.vout ? -1 : 1;
}

/**
 * Merkle root over the sorted leaves.
 *
 * An odd node is PROMOTED, not duplicated. Duplicating the last leaf is what
 * Bitcoin does and it is why CVE-2012-2459 exists: two different leaf sets can
 * produce one root. Promotion has no such pair.
 */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const pair = new Uint8Array(64);
      pair.set(level[i], 0);
      pair.set(level[i + 1], 32);
      next.push(taggedHash(TAG.censusBranch, pair));
    }
    level = next;
  }
  return level[0];
}

/**
 * Canonical census: filter to the height, sort, hash, root.
 *
 * Immutable per height by construction - the same inputs give the same root,
 * which is what lets a node compute it once and cache it forever.
 */
export function buildCensus(entries, { censusHeight, minConfirmations, tipHeight }) {
  const eligible = entries
    .filter((e) => e.height <= censusHeight)
    .filter((e) => tipHeight - e.height + 1 >= minConfirmations)
    .filter((e) => !e.spent)
    .sort(compareEntries);

  for (let i = 1; i < eligible.length; i++)
    if (compareEntries(eligible[i - 1], eligible[i]) === 0)
      throw new Error('duplicate outpoint in census');

  const leaves = eligible.map(leafHash);
  return { entries: eligible, leaves, root: merkleRoot(leaves) };
}
