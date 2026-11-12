// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GUARD EVERY GATHER LOOP OF THE COMMITTEE RUNS BEFORE IT ASKS FOR SHARES (kanban #1807, #2247, #2260; one module since #2369, #2372).
// A peer's commit answer names its own FROST id and nothing else checks it. The forfeit, the settlement, the winnings send (WinningsSend.sign)
// and the reserve payout (reserve-payout.js sign) each put that answer on a list; misnamedSigners and spoiltShares are the one rule all of them
// apply, so a seat answering under another's id is left out (or set aside) in every copy, not only in the two that had it.
import { verifyShare340 } from '../../arena-protocol/src/frost-bip340.js';

/**
 * A COMMITMENT UNDER ANOTHER SEAT'S ID (kanban #1807): a peer's answer at the commit door names its own FROST id, and nothing else checked it. One seat
 * that answered under another's id (or this seat's) put two commitments for one participant on the list, signShare340 threw at the asker, the throw left
 * the forfeit (or settlement) before any seat was left out, and every ask failed the same way until the lock's expiry.
 * Answers { out, aside }: `out` the doors to leave out - those that name this seat's id or an id outside the committee (1..its size, `nodes` the
 * contract's committee; with none known the range is not checked here, and an id with no public share is caught as a share that does not stand).
 * `aside` (kanban #2247, #2260): of two or more doors naming one id only the first stays on this list and the others are set aside for this pass, not
 * left out - dropping them all let one forger under an honest seat's id, with one seat down, take the threshold's last honest seat off every list.
 * The one kept signs; if it is the forger its share does not stand under that id's public share, it is left out, and the honest seat is alone on the
 * next list.
 */
export function misnamedSigners(signers, nodes) {
  const own = signers.find((s) => s.base === null);
  const ownId = own ? String(own.commitment.id) : null;
  const size = Array.isArray(nodes) ? nodes.length : 0;
  const byId = new Map();
  for (const s of signers) {
    if (s.base === null) continue;
    const id = String(s.commitment.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(s.base);
  }
  const out = [];
  const aside = [];
  const kept = [];
  for (const [id, bases] of byId) {
    const n = Number(id);
    if (id === ownId || (size > 0 && !(Number.isInteger(n) && n >= 1 && n <= size))) out.push(...bases);
    else if (bases.length > 1) { kept.push(bases[0]); aside.push(...bases.slice(1)); }
  }
  return { out, aside, kept };
}

/**
 * THE PEERS WHOSE SHARE DOES NOT STAND (kanban #1070, #2247, #2260): each peer's share checked under the public share of the id it committed under. An id
 * with no public share (outside the committee) does not stand; a check that throws does not stand. `shares[i]` belongs to `signers[i]`.
 */
export function spoiltShares({ signers, shares, held, m, commitments, curve }) {
  if (!held || !held.ok || !held.shares) return [];
  return signers.filter((s, i) => {
    if (s.base === null) return false;
    const publicShare = held.shares.get(String(s.commitment.id));
    if (!publicShare) return true;
    try {
      return !verifyShare340({ id: s.commitment.id, share: shares[i], publicShare, groupPublicKey: m.claimPk, message: m.message, commitments, curve });
    } catch { return true; }
  });
}
