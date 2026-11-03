// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH TRANSACTIONS CARRY BITCOIN ARENA, read the way each reader of the chain already reads them (kanban #925 part 2 step 1,
// spec ruling #1101: "the index is a seat's cache: reorg-safe, rebuildable and persisted").
//
// The seat's index (arena-node/src/arena-index.js) keeps a transaction when this answers any kind for it, or when it spends a
// bond the index holds. Every kind is the recogniser its reader runs over whole blocks today, called as it is - no byte rule of
// its own lives here, so a reader that finds a transaction in a whole block finds it in the index too:
//
//   bond      census.js bondCandidateOf - SCAN's own test (this network's marker or the ancestor's, a committed advertisement,
//             the output it names): every census candidate, with the outpoint whose spend the index then follows
//   update    advert-update.js readAdvertUpdate - newestUpdates' test ("ARN" 'A', the marker, the body in the witness)
//   reaffirm  reaffirm.js readReaffirmationPayload - reaffirmedBonds' test ("ARN" 'F'), any network prefix
//   vote      ballot.js decodeVote - ballot-chain.js votesInBlock's test ("ARN" 'V')
//   duty      duty.js dayMarkersOf - the duty and backup day markers ("ARN" 'D' / 'B'), duty-day.js and presence-book.js
//   series    duty.js postedSeriesOf - a series publication ("ARN" 'S'), findSeriesPublication's payload layout
//   round     publication.js's payload layout ("ARN" 'R' round id, PUBLICATION_BYTES): findPublication asks it per round id,
//             the index keeps every one
//   censuskey census-key.js censusKeyAnchorIn and reshareAnchorIn ("ARN" 'K' / 'R' in a 36-byte push), census-key-chain.js
//
// NOT HERE, because nothing in a block alone marks it: a config proposal's deposit (proposals.js: the proposer names the block,
// and the seat reads that transaction by txid) - it is no reader of a range.
import { commitmentsOf } from './tx.js';
import { bondCandidateOf } from './census.js';
import { readAdvertUpdate, readAdvertUpdatePayload } from './advert-update.js';
import { readReaffirmationPayload } from './reaffirm.js';
import { decodeVote } from './ballot.js';
import { dayMarkersOf, postedSeriesOf } from './duty.js';
import { PUBLICATION_MAGIC, PUBLICATION_BYTES, PUBLICATION_KIND_ROUND } from './publication.js';
import { censusKeyAnchorIn, reshareAnchorIn } from './census-key.js';

export const ARENA_KINDS = Object.freeze(['bond', 'update', 'reaffirm', 'vote', 'duty', 'series', 'round', 'censuskey']);

const isRoundPublication = (p) => p.length === PUBLICATION_BYTES && PUBLICATION_MAGIC.every((b, i) => p[i] === b) && p[3] === PUBLICATION_KIND_ROUND;

/**
 * What a parsed transaction carries of Bitcoin Arena on `network` ('regtest', 'testnet4', 'mainnet'): { kinds: [...], bond }
 * - `bond` the census candidate (bondCandidateOf) or null. A network without a bond marker (mainnet until genesis fixes it)
 * finds no bond and no update, as the census finds none there.
 */
export function arenaKindsOf(tx, network) {
  const kinds = [];
  let bond = null;
  try { bond = bondCandidateOf(tx, network); } catch { bond = null; }
  if (bond) kinds.push('bond');
  const payloads = commitmentsOf(tx);
  if (payloads.some((p) => readAdvertUpdatePayload(p))) {
    let read = null;
    try { read = readAdvertUpdate(tx, { network }); } catch { read = null; }
    if (read && read.ok) kinds.push('update');
  }
  if (payloads.some((p) => readReaffirmationPayload(p))) kinds.push('reaffirm');
  if (payloads.some((p) => decodeVote(p))) kinds.push('vote');
  if (dayMarkersOf(tx).length) kinds.push('duty');
  if (postedSeriesOf(tx).length) kinds.push('series');
  if (payloads.some(isRoundPublication)) kinds.push('round');
  if (censusKeyAnchorIn(tx.outputs) || reshareAnchorIn(tx.outputs)) kinds.push('censuskey');
  return { kinds, bond };
}
