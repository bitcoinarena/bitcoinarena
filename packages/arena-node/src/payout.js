// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO ASKS FOR A ROUND'S SETTLEMENT, AND THE STATES AN OLD POOL PAYOUT WAS RECORDED IN.
//
// This file was the on-chain pool payout - a committee pool output, its signed payout table (§20), a FROST spend
// broadcast by one asker, PAYOUT_QUEUED -> PAID - and that payout only ever ran after the hold invoice's settle. It is
// deleted with the custody it served (§23.6, RULED 2026-09-22 22:59; this cut RULED 2026-09-25): a round's
// winners are paid by its lock settlement. What is left is what the lock settlement reads - the asker, chosen from the
// round itself, and when another signer node takes over - and the four state words, which a store from before keeps.

import { toHex } from '../../arena-protocol/src/hash.js';

/** 9.4's two words for the qualifying tail, and they are states now. */
export const PAYOUT_QUEUED = 'PAYOUT_QUEUED';
export const PAID = 'PAID';
export const NOTHING_OWED = 'NOTHING_OWED';
/**
 * PAID WHAT COULD BE PAID, AND STILL SHORT.
 *
 * A round with a winner under the relay floor is not PAID: the outputs that
 * could be made were made and the rest is written down as owed. Calling it
 * PAID would be the operator deciding a debt does not exist because it is
 * small, which is the one thing 23.2 refuses to let inaction do.
 */
export const PAID_IN_PART = 'PAID_IN_PART';

/**
 * WHICH SIGNER NODE ASKS FOR A ROUND'S PAYOUT, AND IT IS EXACTLY ONE.
 *
 * A round's settlement has one asker (settlement.js): it builds the one transaction, collects five nonce
 * commitments and five shares, aggregates them and submits. (It was written for the on-chain pool payout's
 * `payWithCommittee`, deleted with the withdrawn custody; the rule is the lock settlement's now.) Every signer node on
 * the committee closes the round, so if every signer node asked, five of them would
 * run five signing rounds over ONE output. FROST aggregates over the nonces
 * that were committed, so those five are five DIFFERENT transactions spending
 * the same input: one confirms and four are double-spends the chain refuses -
 * and every signer node can only hold one live nonce pair per round, so in practice
 * the five askers deadlock each other instead.
 *
 * So the asker is chosen from the round itself, the way everything else here
 * is: the signer nodes in the order the store keeps them - by pubkey, which no signer node
 * chooses - indexed by the round id. No message, no election, no clock, and
 * every signer node computes the same answer from facts it already holds.
 *
 * WHAT THIS DOES NOT DO is hand the round to somebody else when the asker is
 * down. That needs a clock and a rule for how long to wait, and inventing one
 * here would be inventing the protocol. The round stays PAYOUT_QUEUED, which
 * is a state an operator can see, and it is its own line on the list.
 */
export function askerFor(roundId, signerNodes) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32)
    return { ok: false, why: 'that is not a round id' };
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    return { ok: false, why: 'that round joined nobody, so nobody asks for it' };
  // Four bytes of the round id, big-endian and unsigned. `>>> 0` because a
  // top bit set would otherwise make this negative and the modulo with it.
  const n = ((roundId[0] << 24 | roundId[1] << 16 | roundId[2] << 8 | roundId[3]) >>> 0) % signerNodes.length;
  return { ok: true, asker: signerNodes[n], at: n, of: signerNodes.length };
}

/**
 * HOW LONG A SIGNER NODE GETS BEFORE THE NEXT ONE MAY TRY, IN BITCOIN BLOCKS.
 *
 * Small on purpose. A spend broadcast at the front of its window is normally
 * in the next block, and the signer node behind re-reads the output through
 * `gettxout` - which sees a mempool - before it asks at all, so the wait is
 * not there to let a transaction confirm. It is there so two signer nodes do not
 * start the same signing round in the same instant on the ordinary path.
 *
 * Blocks and not milliseconds: every signer node reads one chain and agrees without
 * talking, where two wall clocks a minute apart both take over.
 */
export const TAKEOVER_BLOCKS = 2;

/**
 * THE ORDER SIGNER NODES TAKE OVER IN, AND NO SIGNER NODE CHOOSES ITS OWN PLACE.
 *
 * `askerFor` names the first. The rest follow it around the ring, so the order
 * is a rotation of the signer nodes the store already keeps sorted BY PUBKEY - which
 * no signer node picks - starting at an index taken from the round id, which is a
 * hash of a contract signed before the round ran. There is nothing here a node
 * can grind: to move up the order it would have to change the round id, and
 * that is a different round.
 */
export function askerOrder(roundId, signerNodes) {
  const first = askerFor(roundId, signerNodes);
  if (!first.ok) return first;
  const order = signerNodes.map((_, i) => signerNodes[(first.at + i) % signerNodes.length]);
  return { ok: true, order, at: first.at, of: signerNodes.length };
}

/**
 * WHICH SIGNER NODES MAY ASK AT THIS BLOCK HEIGHT, AND WHEN THE NEXT ONE MAY.
 *
 * ITEM 19. The asker is picked from the round id, so a signer node that is offline
 * when its round closes leaves the payout at PAYOUT_QUEUED with the other six
 * correctly waiting - and a signer node that never comes back strands the round for
 * ever. Somebody has to be allowed to take over, and the question that decides
 * the shape is what they take over WITH.
 *
 * THE CLOCK IS THE ROUND'S OWN BEACON HEIGHT, which is not a new time source:
 * a round that has no randomness beacon cannot be seeded and cannot be played,
 * so every signer node already holds this number and holds the same one. Wall clocks
 * are per-node - two signer nodes a minute apart would both take over - and the
 * pool output's own confirmations are the wrong anchor, because a pool funded
 * long before the round closes is already deep and every signer node would be
 * eligible at once.
 *
 * Signer node k in the order above may ask once the chain has advanced
 * `k * TAKEOVER_BLOCKS` past the beacon. The round's own asker is k = 0 and is
 * therefore uniquely eligible the moment the round closes.
 *
 * SEVERAL SIGNER NODES ELIGIBLE AT ONCE IS NORMAL AND HARMLESS, and it is worth
 * saying because it looks like the fault. After a long outage the chain is far
 * past the beacon and most of the ring may ask. They do not compete: every
 * signer node's nonce pair is on disk, so a second asker collects the SAME
 * commitments and rebuilds the transaction byte for byte. Measured - before
 * the pair was durable, a restarted committee signed the same spend with
 * different signature bytes; now it is identical.
 */
export function eligibleAsker({ roundId, signerNodes, beaconHeight, tipHeight,
  takeoverBlocks = TAKEOVER_BLOCKS }) {
  const ring = askerOrder(roundId, signerNodes);
  if (!ring.ok) return ring;
  if (!Number.isInteger(beaconHeight) || beaconHeight < 0)
    return { ok: false, why: 'that round names no beacon height to wait from' };
  if (!Number.isInteger(tipHeight) || tipHeight < 0)
    return { ok: false, why: 'this node has no chain tip to measure the wait against' };
  if (!Number.isInteger(takeoverBlocks) || takeoverBlocks <= 0)
    return { ok: false, why: 'a takeover wait is a positive number of blocks' };

  const advanced = tipHeight - beaconHeight;
  const openFor = (k) => advanced >= Math.imul(k, takeoverBlocks);
  const allowed = ring.order.filter((_, k) => openFor(k));
  const next = ring.order.length > allowed.length ? allowed.length : null;
  return {
    ok: true,
    order: ring.order,
    allowed,
    advanced,
    // The height at which the next signer node in the ring joins in, so a refusal can
    // say when rather than only no.
    nextAt: next === null ? null : beaconHeight + Math.imul(next, takeoverBlocks),
    placeOf: (key) => ring.order.findIndex((k) => toHex(k) === toHex(key)),
  };
}

