// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE VERIFIES THE PLAYER'S STAKE LOCK (v4.6.2 §23.1 step 5).
//
// "STAKE_COMMITTED is recorded once >=5 settlement nodes have VERIFIED the
// locks: the contract id at stake_lock_outpoint (and the fee lock's) equals
// the hash of a contract whose payment_image is the entry's stake_point,
// whose amount is the entry's net stake, whose claim_pk is the attested key,
// whose refund_pk is player_pubkey, and whose expiration is >= lock_height
// + stake_expiry_blocks", lock_height no more than 12 blocks below the height the
// seat verifies at. Seeing the lock is not enough: the player built it. (RULED
// 2026-09-24, option (a): lock_height is the federation-held expiration less 144 -
// the one checked below against blockCount + blocksLeft - and blockCount is the
// verify height handed to lockMatchesEntry.)
//
// This is one signer node's half. The player hands the signer node the contract it locked;
// the signer node asks the federation what it holds at the entry's outpoint (the
// stored contract id and the blocks left to its expiry), hashes the handed
// contract with the stock client's own rule, and requires the two to be one
// contract; then protocol stake-lock.js `lockMatchesEntry` checks every field
// against the entry. Only then is the stake seen - the same record the play
// gate reads, so a verified lock and a held HTLC open play the same way.
//
// THE FEDERATION IS A PORT, as Lightning is: `status(outpoint)` answers
// `{ blockCount, stored: { contractId, blocksLeft } | null }` and
// `contractId(fields)` the stock hash (blwp-stake-lock, over the Rust client
// crates). The fee lock is not checked here: its claim hash and the §22A node
// slots wait on a ruling (PRIORITIES).
import { decodeEntryContract, decodeRoundContract, entryFederation } from '../../arena-protocol/src/contracts.js';
import { lockMatchesEntry, lockFieldsFromJson, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { donationOutputsExpected } from '../../arena-protocol/src/donation.js';
import { reservesEntryExpected, paysReserves } from '../../arena-protocol/src/reserves.js';

/**
 * WHETHER THIS ROUND'S GATE MINTS FEE LOCKS (Pick b), by the federation's own fee rule
 * - the same arithmetic the page runs before it locks. Where it mints, a signer node takes no
 * entry without a fee lock and counts no stake whose fee lock it has not verified
 * (2026-09-14, pick (a): refuse at the door - measured before, one entry with no
 * fee lock made the round's one settlement refuse everybody: "an entry's fee lock was
 * never verified, so the fee cannot be claimed").
 */
export async function roundMintsFees({ contract, port, feeBps = undefined }) {
  if (!port || typeof port.fees !== 'function') return { mints: false, why: 'this signer node reads no federation fee rule' };
  const gate = feeLockPays({ contract, fees: await port.fees(), feeBps });
  return { mints: gate.pays, why: gate.why };
}

/**
 * A FEDERATION THAT CHARGES A BASE FEE TAKES MONEY THE OPERATOR DID NOT EARN.
 *
 * FEDERATION.md item 4, and 2026-09-15 07:44: "Fedimint base fee is 0 - run the federation with
 * `disable_base_fees`." §22A says it in the spec's own words: "The 2% stays. Fedimint's own base fees are 0:
 * the federation runs with `disable_base_fees`. Lightning `min_htlc` / routing is not a federation fee."
 *
 * A base fee comes out of EVERY input and output of the round's locks - the players' own pool - so it is not
 * a cost of the round, it is a deduction from the stake somebody already committed. The 2% node fee is
 * inclusive and goes to the round's sitting seats for work they did; a base fee goes to the federation for
 * nothing the round asked for, and the operator must not profit from it.
 *
 * `page-lock.js` already refuses to LOCK against such a federation. This is the same refusal on the node, so
 * a signer node does not sit a round whose stakes would be shaved on the way in and out.
 *
 * AN UNKNOWN RULE IS NOT A BASE FEE. A port that answers nothing is the "no fee rule known: no lock" case the
 * client already has - the round simply mints no fee lock - and is not turned into a refusal here.
 */
export function federationTakesNoBaseFee({ fees }) {
  if (!fees || typeof fees.baseMsat !== 'bigint')
    return { ok: true, why: 'no federation fee rule is known, so no base fee is claimed' };
  if (fees.baseMsat > 0n)
    return { ok: false, baseMsat: fees.baseMsat,
      why: `that round's federation charges a base fee of ${fees.baseMsat} msat on every input and output - `
        + 'a federation for BLWP runs with disable_base_fees (FEDERATION.md), and that fee would come out of '
        + 'the players\' own pool' };
  return { ok: true, why: 'that federation charges no base fee' };
}

const zero = (b) => !(b instanceof Uint8Array) || b.every((x) => x === 0);

// The contract a player hands over, as JSON - one encoding, in protocol, which
// the page's bundle writes with.
export { lockFieldsFromJson, lockFieldsToJson };

/**
 * A DONATION OUTPUT AS THE PLAYER'S LOCK TRANSACTION MAKES IT (2026-10-03, FEDERATION.md): a payout contract -
 * the zero hash image, expired from the start, claim and refund key both the recipient's - so only that key can spend
 * it, with `Refund`, at any time. The same shape the settlement pays a winner with (stake-lock main.rs settle).
 */
// THE SENDER ON THE CONTRACT (2026-10-05): `image` is the entry's 32-byte x-only player key, which a
// page from 0.0.2751 writes; zeros as before when none. Nobody holds a preimage of either, so the claim path stays dead and
// the recipient's Refund is the only spend (measured on a regtest federation: kept, redeemed at once).
export const donationContractFields = ({ recipientPk, amountMsat, image = new Uint8Array(32) }) => ({
  paymentImage: { kind: 'hash', bytes: image }, amountMsat, claimPk: recipientPk, refundPk: recipientPk, expiration: 0,
});

/**
 * THE ENTRY'S DONATION OUTPUTS, CHECKED WITH THE FEDERATION (2026-10-03): for a round whose set pays keys, every
 * output `donationOutputsExpected` pairs - the federation holds, at that outpoint, the payout contract to that key for
 * exactly that share - and none already pays for another entry. Answers the rows to keep, or why the entry's donation
 * is not what its set says. An LNURL round answers none (and refuses outputs it does not name).
 */
export async function verifyDonationOutputs({ round, port, entry, entryIdBytes, recipients, federationId }) {
  if (!recipients) {
    if ((entry.donationOutpoints || []).length) return { ok: false, why: 'this signer node holds no donation set for that round, so it cannot check its donation outputs' };
    return { ok: true, rows: [] };
  }
  const want = donationOutputsExpected(entry, recipients);
  if (!want.ok) return { ok: false, why: `donation: ${want.why}` };
  if (!want.outputs.length) return { ok: true, rows: [] };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a donation output' };
  const rows = [];
  for (const o of want.outputs) {
    const taken = round.donationOutputAt ? round.donationOutputAt(o.outpoint) : null;
    if (taken && !Buffer.from(taken.entryId).equals(Buffer.from(entryIdBytes)))
      return { ok: false, why: 'that donation output already pays for another entry: one output is one entry\'s' };
    // EITHER THE ENTRY'S OWN PLAYER KEY AS THE IMAGE, OR ZEROS (pages already out); any other image is not this entry's
    const sender = entry.playerPubkey instanceof Uint8Array && entry.playerPubkey.length === 32 ? entry.playerPubkey : null;
    const [st, zeroId, keyedId] = await Promise.all([port.status(o.outpoint), port.contractId(donationContractFields(o)),
      sender ? port.contractId(donationContractFields({ ...o, image: sender })) : Promise.resolve(null)]);
    const at = `${Buffer.from(o.outpoint.txid).toString('hex').slice(0, 16)}…:${o.outpoint.outIdx}`;
    if (!st || !st.stored) return { ok: false, why: `donation: the federation holds nothing at ${at}` };
    const stored = String(st.stored.contractId);
    const senderOnContract = keyedId !== null && String(keyedId) === stored;
    if (!senderOnContract && String(zeroId) !== stored)
      return { ok: false, why: `donation: the output at ${at} is not ${o.amountMsat} msat to key ${Buffer.from(o.recipientPk).toString('hex').slice(0, 16)}…` };
    rows.push({ outpoint: o.outpoint, entryId: entryIdBytes, roundId: entry.roundId, federationId, recipientPk: o.recipientPk,
      amountMsat: o.amountMsat, contractId: stored, senderOnContract });
  }
  return { ok: true, rows };
}

/**
 * WHAT AN ENTRY GIVES BESIDE ITS STAKE, CHECKED WITH THE FEDERATION: its donation outputs - and ON PROTOCOL 11 (§27A.9.2, kanban
 *) the developers' 4 % as any donation plus the reserves' 2 %, one output to the entry's federation's reserve key, checked
 * the same way (a payout contract to that key for exactly that amount) and kept beside them as a row for that key.
 */
// `split`: the round's split in force at its census height; unset, today's
export async function verifyEntryGifts({ round, port, entry, contract, entryIdBytes, recipients, reserveKey = null, federationId, split = undefined }) {
  if (!(paysReserves(contract) && entry.reserveOutpoint !== undefined))
    return verifyDonationOutputs({ round, port, entry, entryIdBytes, recipients, federationId });
  const want = reservesEntryExpected({ entry, recipients, reserveKey, ...(split ? { split } : {}) });
  if (!want.ok) return { ok: false, why: `reserves: ${want.why}` };
  const devs = await verifyDonationOutputs({ round, port, entry: { ...entry, donationMsat: entry.donationMsat - want.reserve.amountMsat },
    entryIdBytes, recipients, federationId });
  if (!devs.ok) return devs;
  const res = await verifyDonationOutputs({ round, port, entry: { ...entry, donationMsat: want.reserve.amountMsat, donationOutpoints: [want.reserve.outpoint] },
    entryIdBytes, recipients: [{ recipientPk: reserveKey, shareBps: 10000, label: 'protocol reserves' }], federationId });
  if (!res.ok) return { ok: false, why: res.why.replace(/^donation:/, 'reserves:') };
  return { ok: true, rows: [...devs.rows, ...res.rows.map((r) => ({ ...r, reserve: true }))] };
}

export async function verifyStakeLock({ round, port, entryIdBytes, fields, claimPk, donationRecipients = null, reserveKey = null, split = undefined }) {
  const stored = round.entry(entryIdBytes);
  if (!stored) return { ok: false, why: 'this node holds no such entry' };
  const entry = decodeEntryContract(stored);
  if (entry.stakeMsat === 0n) return { ok: false, why: 'that entry takes no stake, so there is no lock to verify' };
  const row = round.get(entry.roundId);
  if (!row) return { ok: false, why: 'this node holds no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  // THE ENTRY'S FEDERATION (2026.0.3): the one it names on a round that takes any, else the round's (entryFederation)
  const fed = entryFederation(contract, entry);
  if (!fed.ok) return { ok: false, why: fed.why.replace('its stake is not a lock', 'its stake is not a lock') };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a stake lock' };
  const outpoint = entry.stakeLockOutpoint;
  if (!outpoint || zero(outpoint.txid)) return { ok: false, why: 'that entry names no stake lock outpoint' };
  // ONE LOCK IS ONE ENTRY. A lock this signer node already counted for another entry
  // cannot stake a second: two signer nodes on one stake is one signer node played free.
  const taken = round.stakeLockAt ? round.stakeLockAt(outpoint) : null;
  if (taken && !Buffer.from(taken.entryId).equals(Buffer.from(entryIdBytes)))
    return { ok: false, why: 'that stake lock already stakes another entry in this round: one lock is one entry' };

  // THE FEDERATION'S WORD AND THE CONTRACT'S ID ASKED TOGETHER (2026-10-02: "stake/fee verification of 5 of 7
  // confirmations must also be much faster"): two stock-client runs, one after the other before.
  const [st, id] = await Promise.all([port.status(outpoint), port.contractId(fields)]);
  if (!st || !st.stored) return { ok: false, why: 'the federation holds no lock at the entry\'s stake_lock_outpoint' };
  if (String(id) !== String(st.stored.contractId))
    return { ok: false, why: 'the lock at that outpoint is not the contract handed over: its id is another' };
  if (fields.expiration !== st.blockCount + st.stored.blocksLeft)
    return { ok: false, why: 'that contract\'s expiration is not the one the federation holds' };
  if (!(claimPk instanceof Uint8Array)) return { ok: false, why: 'this signer node holds no claim key for that round' };

  const matches = lockMatchesEntry({ lock: fields, entry, kind: 'stake', claimPk, height: st.blockCount, expiryBlocks: contract.stakeExpiryBlocks });
  if (!matches.ok) return matches;

  // AND ITS DONATION, IN THE SAME TRANSACTION (2026-10-03): a stake whose donation outputs are wrong or missing is
  // not counted - nothing is kept for it, and the lock may be handed over again.
  const donated = await verifyEntryGifts({ round, port, entry, contract, entryIdBytes, recipients: donationRecipients, reserveKey, federationId: fed.federationId, split });
  if (!donated.ok) return donated;
  if (donated.rows.length && round.putDonationOutputs) round.putDonationOutputs(donated.rows);

  round.putStakeLock({ entryId: entryIdBytes, roundId: entry.roundId, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
  // IN A ROUND WHOSE GATE MINTS, THE STAKE COUNTS ONLY WITH ITS FEE LOCK (pick a): kept,
  // verified, and not seen - no play, no place in the settlement - until the fee lock is.
  const gate = await roundMintsFees({ contract, port });
  if (gate.mints && !(round.feeLock && round.feeLock(entryIdBytes)))
    return { ok: true, contractId: String(id), paidMsat: fields.amountMsat, height: st.blockCount, waitsForFeeLock: true };
  round.putStakeSeen({ entryId: entryIdBytes, paidMsat: fields.amountMsat });
  return { ok: true, contractId: String(id), paidMsat: fields.amountMsat, height: st.blockCount };
}

/**
 * A SIGNER NODE VERIFIES THE PLAYER'S FEE LOCK (Pick A, 2026-09-14; §23.1 step 5
 * "and the fee lock's"; F5): the entry's 2% node fee, locked to H(F) with F in
 * the entry, the round's claim key and the player's refund key - checked field
 * by field against the entry as the stake lock is. It is claimed for the round's
 * sitting signer nodes in the one settlement, whatever the result.
 */
export async function verifyFeeLock({ round, port, entryIdBytes, fields, claimPk }) {
  const stored = round.entry(entryIdBytes);
  if (!stored) return { ok: false, why: 'this node holds no such entry' };
  const entry = decodeEntryContract(stored);
  if (entry.feeMsat === 0n) return { ok: false, why: 'that entry owes no fee, so there is no fee lock to verify' };
  const row = round.get(entry.roundId);
  if (!row) return { ok: false, why: 'this node holds no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  // THE ENTRY'S FEDERATION (2026.0.3): the one it names on a round that takes any, else the round's (entryFederation)
  const fed = entryFederation(contract, entry);
  if (!fed.ok) return { ok: false, why: fed.why.replace('its stake is not a lock', 'its fee is not a lock') };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a fee lock' };
  const outpoint = entry.feeLockOutpoint;
  if (!outpoint || zero(outpoint.txid)) return { ok: false, why: 'that entry names no fee lock outpoint' };
  if (zero(entry.feePreimage)) return { ok: false, why: 'that entry hands over no F, so its fee lock could never be claimed' };
  const [st, id] = await Promise.all([port.status(outpoint), port.contractId(fields)]);
  if (!st || !st.stored) return { ok: false, why: 'the federation holds no lock at the entry\'s fee_lock_outpoint' };

  if (String(id) !== String(st.stored.contractId))
    return { ok: false, why: 'the lock at that outpoint is not the fee contract handed over: its id is another' };
  if (fields.expiration !== st.blockCount + st.stored.blocksLeft)
    return { ok: false, why: 'that fee contract\'s expiration is not the one the federation holds' };
  if (!(claimPk instanceof Uint8Array)) return { ok: false, why: 'this signer node holds no claim key for that round' };
  const matches = lockMatchesEntry({ lock: fields, entry, kind: 'fee', claimPk, height: st.blockCount, expiryBlocks: contract.stakeExpiryBlocks });
  if (!matches.ok) return matches;
  round.putFeeLock({ entryId: entryIdBytes, roundId: entry.roundId, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
  // AND A STAKE LOCK ALREADY VERIFIED AND WAITING FOR THIS ONE IS COUNTED NOW (pick a).
  const staked = round.stakeLock ? round.stakeLock(entryIdBytes) : null;
  if (staked && !round.stakeSeen(entryIdBytes)) round.putStakeSeen({ entryId: entryIdBytes, paidMsat: lockFieldsFromJson(staked.fields).amountMsat });
  return { ok: true, contractId: String(id), feeMsat: fields.amountMsat, height: st.blockCount };
}
