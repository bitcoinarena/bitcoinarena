// The census: which bonds exist at a height, canonicalised and Merkle-rooted.
//
// Two decisions here are load-bearing and both look like details.

import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { TAG, ROLES, PROTOCOL_VERSION, TYPE_CENSUS_LEAF } from './constants.js';
import { parseTransaction } from './tx.js';

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

/**
 * THE ENTRIES A ROOT WAS TAKEN OVER, AS ONE HASH.
 *
 * 5A.4 makes the root a function of a set and a height: "census_root[role] =
 * Merkle root over their canonical serialization". So a check that a contract
 * names the right root is a comparison against a SET, and a set an accuser
 * chooses is no check at all - hand in a different list and any honest
 * contract looks wrong.
 *
 * The same discipline `payoutInputsId` needed for row 3 of 5A.3, and for the
 * same reason: whoever presents the accusation must be bound to the inputs
 * before the arithmetic is worth anything.
 *
 * SORTED THE CENSUS'S OWN WAY, by outpoint, not by a second rule invented
 * here. 5A.4 is explicit that sorting by `H(node_pubkey)` is grindable - "a
 * node can mine a pubkey to sit anywhere it likes" - and the census already
 * sorts by `(funding_txid, vout)`, which cannot be chosen after the fact.
 */
export function censusInputsId({ censusHeight, minConfirmations, tipHeight, entries }) {
  const w = new Writer();
  w.u8(TYPE_CENSUS_LEAF);
  w.u16(PROTOCOL_VERSION);
  w.u32(censusHeight);
  w.u32(minConfirmations);
  w.u32(tipHeight);
  w.vec([...entries].sort(compareEntries), (e, ww) => {
    ww.bytes(encodeEntry(e), encodeEntry(e).length);
    ww.u8(e.spent ? 1 : 0);
  });
  return taggedHash(TAG.censusInputs, w.finish());
}

/**
 * DOES THIS ROUND NAME THE ROOT ITS OWN CENSUS DERIVES TO?
 *
 * 5A.4: "The Round Contract names `census_height` and both roots. Any
 * participant recomputes them; A CONTRACT WHOSE ROOTS DO NOT MATCH THE CHAIN
 * IS INVALID and no honest node will issue receipts against it."
 *
 * Until this, `censusRoot` was named by every contract and read by no code at
 * all - measured with a grep before the check was written. A round could name
 * any thirty-two bytes and be played, which makes the committee whatever the
 * round's author said it was.
 *
 * THE HEIGHT IS THE CONTRACT'S, not the caller's. Recomputing at another
 * height is recomputing a different census, and a caller who could choose it
 * could make an honest contract look wrong.
 *
 * Answered rather than thrown, like every other decision in this package: a
 * malformed census is a refusal with a reason, not an exception handed to
 * whoever asked whether a round may be played.
 */
export function censusRootMatchesRound(contract, {
  entries, minConfirmations, tipHeight, boundTo,
}) {
  if (!contract || !(contract.censusRoot instanceof Uint8Array)
      || contract.censusRoot.length !== 32)
    return { ok: false, why: 'that round names no census root' };
  if (!Number.isInteger(contract.censusHeight))
    return { ok: false, why: 'that round names no census height' };
  if (!Array.isArray(entries))
    return { ok: false, why: 'no census entries to derive a root from' };

  // AND THE ENTRIES ARE THE PUBLISHED ONES, not whichever set the asker
  // brought. A root is a function of a SET and a height, so a caller free to
  // choose the set can make any honest contract look wrong by handing in a
  // different list - the same free variable row 3 of 5A.3 had before its
  // inputs were bound, and the same fix: whoever presents the question is
  // bound to the inputs before the arithmetic means anything.
  if (!(boundTo instanceof Uint8Array) || boundTo.length !== 32)
    return { ok: false, why: 'no committed census inputs to check those entries against' };

  let bound;
  try { bound = censusInputsId({ censusHeight: contract.censusHeight, minConfirmations, tipHeight, entries }); }
  catch (e) { return { ok: false, why: `those census inputs cannot be committed to: ${e.message}` }; }
  if (!bound.every((b, i) => b === boundTo[i]))
    return {
      ok: false,
      why: 'those are not the census entries that were published: the set, the '
        + 'height or the depth rule differs from what was committed to',
    };

  let census;
  try {
    census = buildCensus(entries, {
      censusHeight: contract.censusHeight, minConfirmations, tipHeight,
    });
  } catch (e) {
    return { ok: false, why: `that census cannot be built: ${e.message}` };
  }

  const same = census.root.every((b, i) => b === contract.censusRoot[i]);
  return same
    ? { ok: true, root: census.root, entries: census.entries.length, why: 'the censusRoot is the one those entries derive to' }
    : {
      ok: false,
      root: census.root,
      entries: census.entries.length,
      why: 'the censusRoot this round names is not the one its entries derive '
        + `to at height ${contract.censusHeight}`,
    };
}

/**
 * 5A.4 STEP 1, SCAN: the chain says where an output was and whether it is
 * still there. Not the party handing the census over.
 *
 * "SCAN all outputs created at or before census_height whose script matches
 * the bond template (5A.3B) and that are unspent at census_height with >=
 * census_confirmations depth."
 *
 * WHAT THIS DOES AND WHAT IT CANNOT. Three of those four conjuncts are read
 * off the blocks here: WHERE an outpoint was created, WHETHER it was spent at
 * or before the census height, and HOW DEEP it is. `buildCensus` applied all
 * three already - to fields the caller supplied. That is the difference: a
 * census used to be a bag of entries someone asserted heights and spends for,
 * and this derives both from the chain, so a publisher who lies about either
 * is caught by anyone holding the same blocks.
 *
 * THE FOURTH CONJUNCT IS NOT HERE AND IS NOT FAKED. Finding which outputs are
 * bonds at all needs `BOND_MARKER` - 25.1's single dust address that puts every
 * bond in the compact filters - and `BOND_MARKER` is `null` in this protocol
 * by a decision recorded in `constants.js`: it is a genesis parameter, fixed
 * once before the first bond exists, and writing a plausible address into a
 * source tree would settle it by accident. `bondMarker()` throws for exactly
 * that reason. So the candidate outpoints come IN - from the advertisements a
 * node already holds, which name `bondTxid` and `bondVout` - and enumerating
 * them from the chain alone waits on that parameter, not on a daemon.
 *
 * A BLOCK IS `{ height, transactions }`, transactions being raw bytes. Nothing
 * here fetches: the caller brings the blocks, and two callers holding the same
 * blocks get the same census or neither does.
 */
export function scanCensus(blocks, { censusHeight, minConfirmations, tipHeight, candidates }) {
  if (!Array.isArray(blocks)) throw new Error('scan needs blocks to read');
  if (!Array.isArray(candidates)) throw new Error('scan needs the outpoints to look for');
  if (!Number.isInteger(censusHeight)) throw new Error('scan needs a census height');

  const createdAt = new Map();
  const spentAt = new Map();

  for (const block of blocks) {
    if (!Number.isInteger(block.height)) throw new Error('a block names its height');

    // AT OR BEFORE THE CENSUS HEIGHT, and nothing after it. A block later than
    // the census is a block the census did not see, and reading it would make
    // the answer depend on when a node happened to ask.
    if (block.height > censusHeight) continue;

    for (const raw of block.transactions) {
      const tx = parseTransaction(raw);
      const txid = toHex(tx.txid);
      for (let vout = 0; vout < tx.outputs.length; vout++)
        if (!createdAt.has(`${txid}:${vout}`)) createdAt.set(`${txid}:${vout}`, block.height);
      for (const input of tx.inputs)
        spentAt.set(`${toHex(input.previousTxid)}:${input.previousVout}`, block.height);
    }
  }

  const found = [];
  const missing = [];
  for (const c of candidates) {
    const key = `${toHex(c.txid)}:${c.vout}`;
    const height = createdAt.get(key);

    // AN OUTPOINT THE CHAIN DOES NOT CARRY IS NOT AN ENTRY. It is named rather
    // than silently dropped: a census that quietly lost a bond and one that
    // never had it look identical from the root alone.
    if (height === undefined) { missing.push({ ...c, why: 'no such outpoint at or before that height' }); continue; }

    found.push({ ...c, height, spent: spentAt.has(key) });
  }

  return {
    entries: found,
    missing,
    census: buildCensus(found, { censusHeight, minConfirmations, tipHeight }),
  };
}
