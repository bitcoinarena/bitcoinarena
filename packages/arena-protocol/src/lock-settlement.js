// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND'S ONE SETTLEMENT OF STAKE LOCKS (FEDERATION.md, money flow step 5;
// W4 - 2026-09-14 07:22: "a loser loses the stake. The lock is claimed
// into the pool. Winners are paid from that.").
//
// THE VERDICT IS THE LOCK'S OWN. `lockActions` (lock-action.js) over one payout
// table decides each entry - the federation's three ends (cut 6b, RULED 2026-09-24:
// the hold invoice's SETTLE/CANCEL/NOTHING are deleted, the outputs unchanged):
//   CLAIM    a loser's stake lock, claimed as an input (`Claim(P)`)
//   RETURN   a qualifier's own lock, forfeited back to them (forfeit.js, W5b)
//   EXPIRE   the lock is left to expire back to its player (VOID, a Delivered run
//            below the score)
// The outputs are one PRE-EXPIRED payout contract per qualifier owed a share:
// `refund_pk` = the key that qualifier's own stake lock names, so only they can
// ever move it (FEDERATION.md source audit, point 2). A qualifier's own stake is
// not in it - that half comes back by the forfeit (`winnings`).
//
// THE GUARDIANS' FEES, AND WHO BEARS THEM. Every input and every output pays
// `base + amount * ppm / 1e6` (lnv2-common config.rs), read from the federation
// (`blwp-stake-lock --mode fees`). They come out of the pool pro rata to what
// each qualifier is owed: target = floor(owed * spendable / pool), then the
// largest payout with payout + fee(payout) <= target. What the floors leave is no
// output and stays with the guardians as fee; a share too small to pay its own
// output fee is reported unpaid, not bumped from anyone else's.
//
// ONE TRANSACTION EVERY SIGNER NODE REBUILDS BYTE FOR BYTE: inputs sorted by outpoint,
// payouts by payout key, and the nonce derived from the round id - so the signer nodes
// sign one txid, and a signer node signs only the txid it rebuilt itself.
// AND THE FEE LOCKS (Pick A, 2026-09-14): every counted entry's fee lock -
// winners' too, the fee is owed whatever the result (F5) - claimed with its F,
// handed over openly at entry, in the same transaction and the same signature.
// They pay the round's SITTING SIGNER NODES by §22A's own weights (`nodeFeeTable`: 1% to
// the game/verify pool, 1% to the settlement pool, per eligible signer node, leftovers in
// the round's order), each signer node one pre-expired payout contract to its own key -
// never to the donation recipients, and no split invented here. A VOID or
// ENTRY_VOID entry's fee lock is not claimed: §22A's fee base leaves it out.
import { paysReserves, RESERVES_NODE_FEE_BPS } from './reserves.js';
import { netStakeMsat, isRefund, FAILED, FORFEIT, VOID, DELIVERED } from './payout.js';
import { lockActions, CLAIM, RETURN } from './lock-action.js';
import { winnings } from './payout-spend.js';
import { nodeFeeTable, entryFeeMsat, frontendShares, frontendBookShares, GAME_VERIFY, SETTLEMENT, GUARDIAN, GATEWAY, LIQUIDITY } from './fee.js';
import { MIN_PLAYERS_PER_ROUND } from './constants.js';
import { refundKeyOf } from './stake-lock.js';
import { splitDonation } from './donation.js';
import { roundId } from './contracts.js';
import { sha256, toHex, fromHex } from './hash.js';

const refuse = (why) => ({ ok: false, why });
const outpointKey_locksettlement = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;

/** The guardians' LNv2 fee on one input or output, in msat. */
export function lnv2FeeMsat({ ppm, baseMsat }, msat) {
  return baseMsat + (msat * ppm) / 1000000n;
}

/** The largest payout whose value and its own fee fit in `target`. */
export function largestPayoutMsat(fees, target) {
  if (target <= fees.baseMsat) return 0n;
  let x = ((target - fees.baseMsat) * 1000000n) / (1000000n + fees.ppm);
  while (x + 1n + lnv2FeeMsat(fees, x + 1n) <= target) x++;
  while (x > 0n && x + lnv2FeeMsat(fees, x) > target) x--;
  return x;
}

const NONCE_TAG = new TextEncoder().encode('blwp lock settlement v1');

/** The settlement transaction's 8-byte nonce: one per round, the same at every signer node. */
export function settlementNonce(roundId) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  const m = new Uint8Array(NONCE_TAG.length + 32);
  m.set(NONCE_TAG); m.set(roundId, NONCE_TAG.length);
  return sha256(m).subarray(0, 8);
}

/**
 * @param {object} o
 * @param {Uint8Array} o.roundId
 * @param {object[]} o.entries  computePayoutTable's entries: pubkey, stakeMsat, feeMsat, donationMsat, outcome, score
 * @param {bigint} [o.minScore]
 * @param {Map<string, {outpoint: {txid: Uint8Array, outIdx: bigint|number}, amountMsat: bigint, refundPk: Uint8Array}>} o.locks
 *        every verified stake lock, keyed by the player's pubkey hex
 * @param {{ppm: bigint, baseMsat: bigint}} o.fees  the guardians' LNv2 fee rule
 */
// `sends`: WINNINGS ALWAYS SENT (2026-09-21; ruled for FEDERATION 2026-09-23). A qualifier with an accepted
// send plan (protocol/winnings-send.js) is paid by an outgoing contract the plan's gateway may claim only by paying
// the winner's invoice, refunding to the round's committee claim key - not by the pre-expired contract only the
// winner's key can move. Keyed by player key hex: { paymentHash, gatewayPk, refundPk, expiration }.
//
// `addressed`: THE POOL (RULED 2026-09-23, (ii) with (iii)). The qualifiers - by player key hex - who named a
// Lightning address. Only they are paid. An unaddressed qualifier's share is folded back into the round's pot and
// split over the addressed ones by the payout table's own weights, renormalised over that set; the dust the msat
// division leaves goes to the first addressed row in the table's order, so nothing claimed is left to the
// guardians as a remainder. With nobody addressed no loser's stake lock is claimed: each expires back to its
// player. Left out, the addressed set is the qualifiers with a send - no address is ever implied.
// `requireSends`: the plan that is signed. An addressed qualifier without an accepted send is refused, never paid
// by a contract only its key can move.
//
// `donationSet`: THE ROUND'S DONATION SET (§22A), as this signer node holds it signed - where a walk-away's claimed lock
// sends its 25% (`remainderSettlement`). An entry marked `atTheDoor` is one this signer node's own store holds FORFEIT at
// the door (§15): no first mark, or a first mark past the line.
//
// `payoutShares`: THE ROUND'S GAME'S TOP SPLIT (manifest.js payoutRuleForRound), or null for §18A's curve. The
// table the locks are claimed and paid by is `lockActions`' over it, so a split round settles by the split and nothing
// else here changes: the payouts are the table's rows, scaled to the claimed locks as any table's are.
export function lockSettlement({ roundId, entries, minScore = 0, locks, fees, feeLocks = new Map(), signerNodes = null, contract = null,
  sends = new Map(), addressed = null, requireSends = false, donationSet = null, payoutShares = null, feeBps = undefined, websitePct = undefined }) {
  // `feeBps` / `websitePct`: the fees in force at the round (fee-proposal.js) - a version-11 round's node fee and the
  // website's share of it; unset, today's (4 % and 20 %)
  if (!(locks instanceof Map)) return refuse('the verified stake locks are a Map by player key');
  if (!(feeLocks instanceof Map)) return refuse('the verified fee locks are a Map by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint' || fees.ppm < 0n || fees.baseMsat < 0n)
    return refuse('the guardians\' fee rule is BigInt ppm and base msat, 0 or more');
  const feePart = feeSettlement({ entries, feeLocks, signerNodes, contract, fees, feeBps, websitePct });
  if (!feePart.ok) return feePart;
  // THE STAKE PART'S VERDICT IS `lockActions`'. A round with losers and nobody to
  // pay is refused there ("the operator would keep ..."), and so its stakes are not
  // claimed here either - but its fee locks still are: the fee is owed.
  let h;
  try { h = lockActions({ roundId, entries, minScore, payoutShares }); } catch (e) {
    if (!feePart.claims.length) return refuse(e.message);
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits: [], poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, stakeWhy: e.message }, feePart);
  }

  const lockOf = (e) => locks.get(toHex(e.pubkey));
  const claims = [];
  for (const a of h.actions) {
    if (a.action !== CLAIM) continue;
    const lock = lockOf(a.entry);
    if (!lock) return refuse(`a loser's stake lock was never verified, so it cannot be claimed: ${toHex(a.entry.pubkey).slice(0, 16)}`);
    const net = netStakeMsat(a.entry);
    if (lock.amountMsat !== net)
      return refuse(`a loser's lock holds ${lock.amountMsat} msat and its entry's net stake is ${net}`);
    claims.push({ pubkey: a.entry.pubkey, outpoint: lock.outpoint, amountMsat: net, atTheDoor: !!a.entry.atTheDoor });
  }
  const forfeits = h.actions.filter((a) => a.action === RETURN).map((a) => a.entry.pubkey);
  if (!claims.length && !feePart.claims.length)
    return { ok: true, nothing: true, why: 'no loser\'s lock is claimed in this round', claims, payouts: [], unpaid: [], forfeits,
      poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n,
      feePoolMsat: 0n, signerNodePayouts: [], feeClaims: [] };
  if (!claims.length)
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits, poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n,
      stakeWhy: 'no loser\'s lock is claimed in this round' }, feePart);
  const remainderArgs = { roundId, forfeits, fees, contract, donationSet, sends, requireSends, feePart };
  // NOBODY QUALIFIES AND A WALK-AWAY'S LOCK IS CLAIMED (lockActions): its stake is the round's remainder, split 75/25.
  if (h.remainderMsat > 0n)
    return remainderSettlement({ ...remainderArgs, claims, unpaid: [],
      stakeWhy: 'nobody qualifies: the walk-away\'s lock is claimed and split 75% to the sitting signer nodes, 25% to the donation set' });

  const owed = winnings({ table: h.table.table, stakes: h.table.activated });
  if (!owed.ok) return refuse(owed.why);
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  if (owed.owedMsat !== poolMsat)
    return refuse(`the table hands out ${owed.owedMsat} msat and the claimed locks hold ${poolMsat}`);
  for (const row of owed.rows) {
    const e = h.table.activated.find((x) => toHex(x.pubkey) === toHex(row.pubkey));
    if (!e || !lockOf(e)) return refuse(`a qualifier's stake lock was never verified, so there is no key to pay: ${toHex(row.pubkey).slice(0, 16)}`);
  }
  // WINNINGS-AUTO (RULED 2026-10-01): EVERY QUALIFIER IS PAID, by its payout contract into its federation wallet -
  // never by a Lightning send to a named address, and no share is pooled for want of one. `addressed` and qualifier
  // `sends` (the 2026-09-23 path) decide nothing any more.
  void addressed;
  const sendOf = () => null;
  const pooled = [];
  let paying = [...owed.rows];
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  const unpaid = [...pooled];
  // A WALK-AWAY IS NEVER A REFUND (RULED 2026-09-30): with nobody to send the winnings to, the other losers' locks
  // expire back - and a walk-away's is claimed all the same, into the remainder split.
  const nobody = (why) => {
    const door = claims.filter((c) => c.atTheDoor);
    if (door.length)
      return remainderSettlement({ ...remainderArgs, claims: door, unpaid,
        stakeWhy: `${why}; the walk-away's lock is claimed and split 75% to the sitting signer nodes, 25% to the donation set` });
    return finish({ roundId, claims: [], payouts: [], unpaid, forfeits, poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n,
      stakeWhy: why }, feePart);
  };
  // (iii): NOBODY TO SEND TO, NOTHING CLAIMED. The losers' locks expire back to them; the fee part still settles.
  // An addressed qualifier outside the paying ranks has no weight in the table, so it cannot carry the pooled
  // shares either: renormalised over weights that sum to nothing there is no split, and none is invented.
  if (!paying.length) return nobody('no qualifier holds a paying rank, so no loser\'s lock is claimed and each expires back to its player');
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the claimed locks (${inputFeesMsat} msat) take the whole pool of ${poolMsat}`);

  // THE TABLE'S WEIGHTS OVER THE ADDRESSED SET. A row whose share cannot pay its own output fee leaves the split
  // too - its share folds back like an unaddressed one - and the rest is split again.
  let split;
  for (;;) {
    const weight = paying.reduce((s, r) => s + r.msat, 0n);
    split = paying.map((r) => ({ row: r, msat: largestPayoutMsat(fees, (r.msat * spendableMsat) / weight) }));
    const small = split.filter((x) => x.msat === 0n);
    if (!small.length) break;
    for (const x of small) unpaid.push({ pubkey: x.row.pubkey, owedMsat: x.row.msat, why: 'its share does not pay its own output fee' });
    paying = paying.filter((r) => !small.some((x) => x.row === r));
    if (!paying.length) return nobody('no qualifier\'s share pays its own output fee, so no loser\'s lock is claimed and each expires back to its player');
  }
  // THE DUST TO THE FIRST ADDRESSED ROW of the table's own order: the payouts and their fees are the whole spendable pot.
  const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
  const dust = spendableMsat - split.reduce((s, x) => s + gross(x.msat), 0n);
  if (dust > 0n) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);

  const payouts = [];
  for (const { row, msat } of split) {
    const send = sendOf(row);
    // A SEND PLANNED FOR ANOTHER AMOUNT IS NOT BUILT ON: its invoice was sized for that payout, not this one.
    if (send && send.payoutMsat !== undefined && BigInt(send.payoutMsat) !== msat)
      return refuse(`a send was planned for a ${send.payoutMsat} msat payout and this signer node's payout is ${msat}: ${toHex(row.pubkey).slice(0, 16)}`);
    if (send) {
      payouts.push({ pubkey: row.pubkey, payoutPk: send.refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat),
        sent: { paymentHash: String(send.paymentHash).toLowerCase(), gatewayPk: String(send.gatewayPk).toLowerCase(),
          expiration: BigInt(send.expiration) } });
      continue;
    }
    // the payout contract to the qualifier's own key, redeemed by its client into its federation wallet (WINNINGS-AUTO)
    const e = h.table.activated.find((x) => toHex(x.pubkey) === toHex(row.pubkey));
    payouts.push({ pubkey: row.pubkey, payoutPk: lockOf(e).refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat) });
  }
  // THE SHARES A LATE LOSER'S SECOND SETTLEMENT IS SPLIT BY (C3b-1): what each paid winner got, in the table's order.
  const stakeShares = split.map(({ row, msat }) => ({ pubkey: row.pubkey, msat }));
  return { ...finish({ roundId, claims: claims.map(stakeClaim), payouts: payouts.map((p) => ({ ...p, kind: p.sent ? 'sent' : 'qualifier' })),
    unpaid, forfeits, poolMsat, inputFeesMsat, spendableMsat, stakeWhy: null }, feePart), stakeShares };
}

const stakeClaim = ({ atTheDoor: _door, ...c }) => ({ ...c, kind: 'stake' });

/**
 * AN ATTESTED ROUND'S SETTLEMENT (§0A.7a2026-10-07): the pari-mutuel table, paid. `table` is
 * attested.js `pariMutuelTable` over the round's counted entries and its final outcome; `entries` the same entries with
 * their player keys (`pubkey`) and entry ids (hex). Every counted entry's fee lock is claimed and the sitting signer nodes
 * are paid by §22A's table, as for any round (`feeSettlement`). The LOSING picks' stake locks are claimed, and each winner
 * is paid its share of the losing pool - `payoutMsat - netMsat` of its table row - by the payout contract to its own key
 * (the shape a nextblock qualifier is paid by, kind 'qualifier'); a winner's own stake lock is not claimed and comes back
 * to it by the stake-return path. Nobody picked the outcome (`table.refunded`): no stake lock is claimed, only the fee
 * locks. Under a fee rule that charges, the shares are scaled to what the claimed locks can pay, the dust to the first.
 *
 * A SCALAR MARKET'S TABLE (feature 8, scalar.js scalarPayoutTable) IS READ BY THE SAME RULE, because a lock moves
 * whole: a row that gets back LESS than its net stake (`won` false) has its lock claimed, and - unlike a pari-mutuel loser, whose
 * payout is 0 - is paid its `payoutMsat` back out of the claimed pool by the same payout contract to its own key; a row that gets
 * back at least its net (`won`) keeps its lock and is paid the excess, as a winner. The claimed pool then pays exactly the
 * winners' excess plus the claimed rows' rest. Every pari-mutuel table pays a loser 0, so what it builds is unchanged.
 */
// `donation`: { recipients }, the market's donation target - its donation is in the fee locks (feeSettlement), due here
export function attestedLockSettlement({ roundId, table, entries, locks, fees, feeLocks = new Map(), signerNodes = null, contract = null, feeBps = undefined, donation = null }) {
  if (!(locks instanceof Map) || !(feeLocks instanceof Map)) return refuse('the verified locks are Maps by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint') return refuse('the guardians\' fee rule is BigInt ppm and base msat');
  if (!table || !Array.isArray(table.rows)) return refuse('an attested round is settled from its pari-mutuel table');
  const byId = new Map(entries.map((e) => [typeof e.entryId === 'string' ? e.entryId : toHex(e.entryId), e]));
  // THE FEE PART: every counted entry, as for any round (none is a refund: a pick is a counted stake)
  const counted = table.rows.map((r) => ({ ...byId.get(r.entryId), outcome: DELIVERED, score: 0 }));
  if (counted.some((e) => !e.pubkey)) return refuse('a row of the table names an entry this signer node does not hold');
  const feePart = feeSettlement({ entries: counted, feeLocks, signerNodes, contract, fees, feeBps, donation });
  if (!feePart.ok) return feePart;
  const empty = (why) => ({ roundId, claims: [], payouts: [], unpaid: [], forfeits: [], poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, stakeWhy: why });
  // NOBODY PICKED THE OUTCOME: NOTHING IS CLAIMED, THE FEES TOO (2026-10-09: "refund the fees too") - every
  // stake comes back by the return door at once (forfeit.js), every fee lock to its player at its expiry; no settlement moves
  if (table.refunded || !table.rows.some((r) => r.won))
    // (a scalar market's one-sided round says so in its own words: scalar.js scalarOneSided)
    return { ok: true, nothing: true, refunded: true, why: table.refunded && table.why ? `${table.why}: nothing is claimed` : 'nobody picked the outcome: nothing is claimed - every stake comes back, its fee too' };
  const losers = table.rows.filter((r) => !r.won && r.netMsat > 0n);
  const winners = table.rows.filter((r) => r.won);
  const claims = [];
  for (const r of losers) {
    const e = byId.get(r.entryId);
    const lock = locks.get(toHex(e.pubkey));
    if (!lock) return refuse(`a losing pick's stake lock was never verified, so it cannot be claimed: ${r.entryId.slice(0, 16)}`);
    if (lock.amountMsat !== r.netMsat) return refuse(`a losing pick's lock holds ${lock.amountMsat} msat and its net stake is ${r.netMsat}`);
    claims.push({ pubkey: e.pubkey, outpoint: lock.outpoint, amountMsat: r.netMsat, kind: 'stake' });
  }
  if (!claims.length) return finish(empty('every pick won: no losing stake to claim'), feePart);
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the losing locks (${inputFeesMsat} msat) take the whole pool of ${poolMsat}`);
  // EACH WINNER'S SHARE OF THE LOSING POOL, as the table says it, over what the claimed locks can pay after their fees - and
  // after them, a scalar market's claimed rows that get some of their stake back (none in a pari-mutuel table)
  const shares = winners.map((r) => ({ r, owed: r.payoutMsat - r.netMsat }))
    .concat(losers.filter((r) => r.payoutMsat > 0n).map((r) => ({ r, owed: r.payoutMsat })));
  const owedTotal = shares.reduce((s, x) => s + x.owed, 0n);
  if (owedTotal !== poolMsat) return refuse(`the table hands the winners ${owedTotal} msat and the losing locks hold ${poolMsat}`);
  const split = shares.map((x) => ({ ...x, msat: largestPayoutMsat(fees, (x.owed * spendableMsat) / poolMsat) }));
  const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
  const dust = spendableMsat - split.reduce((s, x) => s + gross(x.msat), 0n);
  if (dust > 0n) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);
  const payouts = [];
  for (const x of split) {
    if (x.msat <= 0n) continue;
    const e = byId.get(x.r.entryId);
    const lock = locks.get(toHex(e.pubkey));
    const payoutPk = lock ? lock.refundPk : refundKeyOf(e.pubkey);
    payouts.push({ pubkey: e.pubkey, payoutPk, owedMsat: x.owed, msat: x.msat, feeMsat: lnv2FeeMsat(fees, x.msat), kind: 'qualifier' });
  }
  return { ...finish({ roundId, claims, payouts, unpaid: [], forfeits: [], poolMsat, inputFeesMsat, spendableMsat, stakeWhy: null }, feePart),
    stakeShares: split.map((x) => ({ pubkey: byId.get(x.r.entryId).pubkey, msat: x.msat })) };
}

/** THE RULED REMAINDER SPLIT (FEDERATION.md; RULED 2026-09-21): 75% to the nodes, the rest to the donation set. */
export const REMAINDER_NODES_PERCENT = 75n;

const DONATION_SEND_TAG = new TextEncoder().encode('blwp donation send v1');

/**
 * THE ID A DONATION SEND IS KEPT AND SIGNED UNDER: one per (round, recipient in the set's published order). It stands
 * where a player send's entry id stands (winnings-send.js), since a recipient has no entry.
 */
export function donationSendId(roundId, index) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error('a donation recipient is 0..255 in the set\'s order');
  const m = new Uint8Array(DONATION_SEND_TAG.length + 33);
  m.set(DONATION_SEND_TAG); m.set(roundId, DONATION_SEND_TAG.length); m[DONATION_SEND_TAG.length + 32] = index;
  return sha256(m);
}

/**
 * A WALK-AWAY'S CLAIMED LOCK, PAID BY THE RULED REMAINDER SPLIT (RULED 2026-09-30, destination 1): a round
 * nobody is paid in claims the locks of the entries held FORFEIT at the door, and never hands them back. Less the
 * guardians' fees on those inputs, 75% goes to the round's SITTING SIGNER NODES - evenly, each one pre-expired payout
 * contract to its own key, as the fee locks pay them; the msat the division leaves to the first in the round's order -
 * and 25% to the round's DONATION SET by share_bps (§22A's `splitDonation`, its remainder to the first as published),
 * each recipient paid by the Lightning-address send a winner is paid by (winnings-send.js): an outgoing contract to
 * that recipient's invoice, refunding to the committee claim key. A recipient has no key, so no contract only its
 * owner can move is possible - and so, where `requireSends` says the plan is the signed one, a recipient without an
 * accepted send is REFUSED: nothing is built. A share too small to pay its own output fee is reported unpaid.
 *
 * A RECIPIENT THAT DOES NOT ANSWER (RULED 2026-09-30, hole 1 (a)): the seats' accepted plan names that share
 * HELD (`send.held`) - no invoice - and the settlement pays it into a pre-expired contract under the committee claim
 * key only, so the signer nodes can retry the Lightning-address send to that same recipient (winnings-send.js). It
 * is not a signer fee, not a gift, not a refund to the walker, and it never joins the 75%: unpaid, it stays there.
 */
function remainderSettlement({ roundId, claims, forfeits, fees, contract, donationSet, sends, requireSends, feePart, unpaid, stakeWhy }) {
  const sitting = contract && Array.isArray(contract.nodes) ? [...new Map(contract.nodes.map((k) => [toHex(k), k])).values()] : [];
  if (!sitting.length) return refuse('a walk-away\'s lock is split with the round\'s sitting signer nodes, and no contract names them');
  const recipients = donationSet && Array.isArray(donationSet.recipients) ? donationSet.recipients : null;
  if (!recipients || !recipients.length)
    return refuse('a walk-away\'s lock pays 25% to the round\'s donation set, and this signer node holds no signed set for the round, so nothing is built');
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the walk-away's lock (${inputFeesMsat} msat) take the whole ${poolMsat}`);
  const nodesMsat = (spendableMsat * REMAINDER_NODES_PERCENT) / 100n;
  const donationMsat = spendableMsat - nodesMsat;
  const out = [...unpaid];
  const payouts = [];
  const each = nodesMsat / BigInt(sitting.length);
  sitting.forEach((k, i) => {
    const owedMsat = each + (i === 0 ? nodesMsat - each * BigInt(sitting.length) : 0n);
    const msat = largestPayoutMsat(fees, owedMsat);
    if (msat === 0n) { out.push({ pubkey: k, owedMsat, why: 'its share of the walk-away\'s stake does not pay its own output fee' }); return; }
    payouts.push({ pubkey: k, payoutPk: refundKeyOf(k), owedMsat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'remainder node' });
  });
  const split = splitDonation({ donationMsat, recipients });
  if (!split.owed) return refuse(`the round's donation set does not stand, so nothing is built: ${split.why}`);
  for (let i = 0; i < split.shares.length; i++) {
    const { lnurl, amountMsat: owedMsat } = split.shares[i];
    const id = donationSendId(roundId, i);
    // A RECIPIENT WITH A KEY (2026-10-03, FEDERATION.md "Donations in the federation"): paid as a winner is - a
    // pre-expired payout contract to its own key, which only it can redeem. No Lightning send, nothing held for a retry.
    if (split.shares[i].recipientPk instanceof Uint8Array) {
      const pk = split.shares[i].recipientPk;
      const msat = largestPayoutMsat(fees, owedMsat);
      if (msat === 0n) { out.push({ pubkey: id, owedMsat, why: `the donation share for ${split.shares[i].label || 'a key'} does not pay its own output fee` }); continue; }
      payouts.push({ pubkey: id, payoutPk: pk, owedMsat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'donation key',
        donation: { id, index: i, recipientPk: pk, label: split.shares[i].label } });
      continue;
    }
    const donation = { id, index: i, lnurl };
    const msat = largestPayoutMsat(fees, owedMsat);
    if (msat === 0n) { out.push({ pubkey: id, owedMsat, why: `the donation share for ${lnurl} does not pay its own output fee` }); continue; }
    const send = sends instanceof Map ? sends.get(toHex(id)) : null;
    if (send && send.payoutMsat !== undefined && BigInt(send.payoutMsat) !== msat)
      return refuse(`a donation send was planned for a ${send.payoutMsat} msat payout and this signer node's payout is ${msat}: ${lnurl}`);
    if (send && send.held) {
      payouts.push({ pubkey: id, payoutPk: send.refundPk, owedMsat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'held', donation });
      continue;
    }
    if (send) {
      payouts.push({ pubkey: id, payoutPk: send.refundPk, owedMsat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'sent', donation,
        sent: { paymentHash: String(send.paymentHash).toLowerCase(), gatewayPk: String(send.gatewayPk).toLowerCase(), expiration: BigInt(send.expiration) } });
      continue;
    }
    // THE DONATION SEND IS MISSING: the signed plan is refused, and the walk-away's lock is not claimed on a guess.
    if (requireSends) return refuse(`the donation set's share for ${lnurl} has no accepted Lightning-address send, so nothing is built`);
    // THE BASE PLAN the donation sends are sized from; never signed (requireSends). A recipient has no key to name.
    payouts.push({ pubkey: id, payoutPk: new Uint8Array(33), owedMsat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'donation', donation });
  }
  const done = finish({ roundId, claims: claims.map(stakeClaim), payouts, unpaid: out, forfeits, poolMsat, inputFeesMsat, spendableMsat, stakeWhy }, feePart);
  if (!done.ok) return done;
  return { ...done, remainder: { nodesMsat, donationMsat, sitting: sitting.length, recipients: split.shares.length,
    heldMsat: payouts.filter((p) => p.kind === 'held').reduce((t, p) => t + p.msat, 0n) } };
}

const LATE_NONCE_TAG = new TextEncoder().encode('blwp late lock settlement v1');

/** A late loser's second settlement's 8-byte nonce: one per (round, entry), never the round's own. */
export function lateSettlementNonce(roundId, entryId) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('an entry id is 32 bytes');
  const m = new Uint8Array(LATE_NONCE_TAG.length + 64);
  m.set(LATE_NONCE_TAG); m.set(roundId, LATE_NONCE_TAG.length); m.set(entryId, LATE_NONCE_TAG.length + 32);
  return sha256(m).subarray(0, 8);
}

/**
 * THE SECOND SETTLEMENT OF A LATE LOSER (§13A; RULED 2026-09-24, slice C3b-1). An entry the round's settlement left
 * out while it was still in its re-run window, which then ended FINAL and FAILED, or FORFEIT, is claimed in its own
 * transaction, one per (round, entry). Its lock's net stake, less this transaction's own guardian fees, goes to the
 * winners the first transaction paid - `shares`, that settlement's `stakeShares`: each winner's first payout, in the
 * first table's order - each by its first payout's fraction of the first pool, integer msat, a share too small to pay
 * its own output fee folded back and split again, the dust to the first row, as the first table does. Paid by a
 * pre-expired payout contract to the winner's own lock key (`winnerLocks`), as the base plan does. Nobody already paid
 * is reduced; the first transaction is not touched. The late entry's fee lock, where minted, is claimed in the same
 * transaction and pays the round's sitting signer nodes by §22A, never the pool. A late VOID is not claimed (its lock
 * returns at expiry); a late qualifier is not claimed (its stake comes back by its own forfeit, no share); and when
 * the first settlement paid nobody, nothing is claimed.
 */
export function lateLockSettlement({ roundId, entryId, entry, lock, feeLock = null, shares, winnerLocks = new Map(), fees,
  signerNodes = null, contract = null, sends = new Map(), requireSends = false, feeBps = undefined, websitePct = undefined }) {
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint' || fees.ppm < 0n || fees.baseMsat < 0n)
    return refuse('the guardians\' fee rule is BigInt ppm and base msat, 0 or more');
  if (!entry) return refuse('there is no late entry to settle');
  if (entry.outcome === VOID || isRefund(entry.outcome))
    return refuse(`a late ${entry.outcome} is not claimed: nothing acts, and the lock returns to its player at its expiry`);
  if (entry.outcome === DELIVERED)
    return refuse('a late DELIVERED run is not claimed: a qualifier\'s stake comes back by its own forfeit - stake back only, no share');
  if (entry.outcome !== FAILED && entry.outcome !== FORFEIT) return refuse(`a late ${entry.outcome} is not a loser, so nothing is claimed`);
  if (!Array.isArray(shares) || !shares.length)
    return refuse('the first settlement paid nobody, so the late lock is not claimed: it returns to its player at its expiry');
  if (!lock) return refuse('the late loser\'s stake lock was never verified, so it cannot be claimed');
  const net = netStakeMsat(entry);
  if (lock.amountMsat !== net) return refuse(`the late loser's lock holds ${lock.amountMsat} msat and its entry's net stake is ${net}`);
  if (!(winnerLocks instanceof Map)) return refuse('the winners\' stake locks are a Map by player key');

  const inputFeesMsat = lnv2FeeMsat(fees, net);
  const spendableMsat = net - inputFeesMsat;
  if (spendableMsat <= 0n) return refuse(`the guardians' fee on the late lock (${inputFeesMsat} msat) takes its whole ${net}`);
  const unpaid = [];
  let paying = [...shares];
  let split;
  for (;;) {
    const weight = paying.reduce((t, x) => t + x.msat, 0n);
    split = paying.map((x) => ({ row: x, msat: largestPayoutMsat(fees, (x.msat * spendableMsat) / weight) }));
    const small = split.filter((x) => x.msat === 0n);
    if (!small.length) break;
    for (const x of small) unpaid.push({ pubkey: x.row.pubkey, owedMsat: x.row.msat, why: 'its share of the late stake does not pay its own output fee' });
    paying = paying.filter((x) => !small.some((y) => y.row === x));
    if (!paying.length) return refuse('no winner\'s share of the late stake pays its own output fee, so the late lock is not claimed');
  }
  const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
  const dust = spendableMsat - split.reduce((t, x) => t + gross(x.msat), 0n);
  if (dust > 0n) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);
  // SENT, WHERE A LATE SEND PLAN STANDS (slice C3b-2a): an outgoing contract to the winner's invoice, refunding to the
  // committee claim key - so no winner's lock key is needed to pay it - for exactly the payout the split gives.
  // Otherwise the base plan's pre-expired payout contract to the winner's own lock key (C3b-1), never signed where
  // `requireSends` says the sends are required.
  const payouts = [];
  // WINNINGS-AUTO (RULED 2026-10-01): a late share is paid as every winning is - the pre-expired payout contract
  // to the winner's own lock key (C3b-1), redeemed into its federation wallet - never a send (C3b-2a withdrawn).
  void sends; void requireSends;
  for (const { row, msat } of split) {
    const wl = winnerLocks.get(toHex(row.pubkey));
    if (!wl) return refuse(`a winner's stake lock was never verified, so there is no key to pay: ${toHex(row.pubkey).slice(0, 16)}`);
    payouts.push({ pubkey: row.pubkey, payoutPk: wl.refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat), kind: 'qualifier' });
  }

  const feePart = feeLock
    ? feeSettlement({ entries: [entry], feeLocks: new Map([[toHex(entry.pubkey), feeLock]]), signerNodes, contract, fees, feeBps, websitePct })
    : feeSettlement({ entries: [entry], feeLocks: new Map(), signerNodes, contract, fees, feeBps, websitePct });
  if (!feePart.ok) return feePart;
  const done = finish({ roundId, claims: [{ pubkey: entry.pubkey, outpoint: lock.outpoint, amountMsat: net, kind: 'stake' }], payouts,
    unpaid, forfeits: [], poolMsat: net, inputFeesMsat, spendableMsat, stakeWhy: null }, feePart);
  if (!done.ok) return done;
  return { ...done, nonce: lateSettlementNonce(roundId, entryId), late: true };
}

const byOutpoint = (a, b) => (outpointKey_locksettlement(a.outpoint) < outpointKey_locksettlement(b.outpoint) ? -1 : outpointKey_locksettlement(a.outpoint) > outpointKey_locksettlement(b.outpoint) ? 1 : 0);
// BY PAYOUT KEY, and among sent winnings - which all refund to the one committee key - by payment hash, so every
// signer node lists the same outputs in the same order.
const payoutOrderKey = (p) => `${toHex(p.payoutPk)}:${p.sent ? p.sent.paymentHash : ''}`;
const byPayoutPk = (a, b) => (payoutOrderKey(a) < payoutOrderKey(b) ? -1 : payoutOrderKey(a) > payoutOrderKey(b) ? 1 : 0);

/** The stake part and the fee part as ONE transaction: inputs by outpoint, payouts by key, the round's nonce. */
function finish(stake, fee) {
  const claims = [...stake.claims, ...fee.claims].sort(byOutpoint);
  const payouts = [...stake.payouts, ...fee.payouts].sort(byPayoutPk);
  const paidMsat = stake.payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = stake.payouts.reduce((s, p) => s + p.feeMsat, 0n);
  const unspentMsat = stake.spendableMsat - paidMsat - outputFeesMsat;
  if (unspentMsat < 0n) return refuse('the payouts and their fees come to more than the claimed locks pay for');
  if (fee.unspentMsat < 0n) return refuse('the signer nodes\' payouts and their fees come to more than the fee locks pay for');
  return { ok: true, nothing: false, claims, payouts, unpaid: [...stake.unpaid, ...fee.unpaid], forfeits: stake.forfeits,
    nonce: settlementNonce(stake.roundId), stakeWhy: stake.stakeWhy,
    poolMsat: stake.poolMsat, inputFeesMsat: stake.inputFeesMsat, spendableMsat: stake.spendableMsat, paidMsat, outputFeesMsat, unspentMsat,
    feeClaims: fee.claims, signerNodePayouts: fee.payouts, feePoolMsat: fee.poolMsat, feeInputFeesMsat: fee.inputFeesMsat,
    feePaidMsat: fee.paidMsat, feeOutputFeesMsat: fee.outputFeesMsat, feeUnspentMsat: fee.unspentMsat, feeUnallocatedMsat: fee.unallocatedMsat,
    feeHole: fee.hole || null };
}

/**
 * WHETHER A FEE LOCK CAN PAY A SIGNER NODE - THE GATE THE PAGE ASKS BEFORE IT MINTS ONE
 * (Pick b, 2026-09-14: "Do not mint a fee lock when claiming it cannot pay
 * a sitting signer node ... The operator must not take money that only pays the
 * federation.").
 *
 * The signer nodes' own fee arithmetic (`feeSettlement`), run on the round's WORST case -
 * the fewest players a round opens for (more only raise each signer node's share) - over
 * the signer nodes the settlement pays: the round's own sitting signer nodes, its `nodes`, in
 * both pools (2026-09-15 07:42: "22A node fee goes to the sitting signer nodes of
 * this round, even if there are only two. Not seven census slots when the round is
 * 2-of-2."). It used to invent one different signer node per slot - four for a 2-of-2
 * the settlement pays as two. It pays only if every sitting signer node would be paid
 * strictly more than nothing after the federation's own fee on every input and
 * output. `fees` is the federation's rule, read by the page's own lock client -
 * not a signer node's word.
 */
// `feeBps`: the round's game's node fee (fee.js feeBpsOf - a market's own, 0.5 % by default), the network's if none
export function feeLockPays({ contract, fees, players = MIN_PLAYERS_PER_ROUND, feeBps = undefined } = {}) {
  if (!contract) return { pays: false, why: 'no round to size the fee lock for' };
  if (feeBps === undefined && paysReserves(contract)) feeBps = RESERVES_NODE_FEE_BPS;   // version 11: 4 %
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint')
    return { pays: false, why: 'the federation\'s fee rule is not known, so no fee lock is minted' };
  const stakeMsat = BigInt(contract.stakeMsat || 0n);
  const lockMsat = entryFeeMsat(stakeMsat, feeBps);
  // THE ROUND'S SITTING SIGNER NODES, each once - the signer nodes its settlement pays, in both pools.
  const sitting = Array.isArray(contract.nodes) ? [...new Map(contract.nodes.map((k) => [toHex(k), k])).values()] : [];
  const base = { stakeMsat, lockMsat, players, signerNodes: sitting.length };
  if (lockMsat <= 0n) return { ...base, pays: false, why: 'this round owes no fee, so there is nothing to lock' };
  if (!sitting.length) return { ...base, pays: false, why: 'that round names no sitting signer nodes, so a fee lock would pay nobody' };
  const key = (tag, i) => { const k = new Uint8Array(32); k[0] = tag; k[1] = i; k[31] = 1; return k; };
  const pools = { [GAME_VERIFY]: sitting, [SETTLEMENT]: sitting };
  const entries = Array.from({ length: players }, (_, i) => ({ pubkey: key(0xb0, i), stakeMsat, feeMsat: lockMsat, donationMsat: 0n, outcome: FAILED, score: 0 }));
  const feeLocks = new Map(entries.map((e, i) => [toHex(e.pubkey), { outpoint: { txid: key(0xc0, i), outIdx: BigInt(i) }, amountMsat: lockMsat, preimage: key(0xd0, i) }]));
  const part = feeSettlement({ entries, feeLocks, signerNodes: pools, contract, fees, feeBps });
  if (!part.ok) return { ...base, pays: false, why: part.why };
  const out = { ...base, inputFeesMsat: part.inputFeesMsat, outputFeesMsat: part.outputFeesMsat,
    perSignerNodeNetMsat: part.payouts.map((p) => p.msat), unpaidSignerNodes: part.unpaid.length };
  if (part.hole) return { ...out, pays: false, why: part.hole.why };
  if (part.unpaid.length) return { ...out, pays: false, why: `${part.unpaid.length} entitled signer node(s) would be paid nothing after the federation's fees` };
  if (!part.payouts.length || part.payouts.some((p) => p.msat <= 0n)) return { ...out, pays: false, why: 'a signer node would be paid nothing after the federation\'s fees' };
  return { ...out, pays: true, why: `every one of ${part.payouts.length} signer nodes is paid more than nothing after the federation's fees` };
}

/**
 * THE FEE PART: every counted entry's fee lock in, each sitting signer node's §22A share
 * out. `signer nodes` names the round's sitting committee by pool ({ gameVerify,
 * settlement }: x-only keys); `feeLocks` the verified fee locks by player key,
 * each with its outpoint, amount and F.
 */
// `donation`: { recipients } - a market's donation target (two sets: the protocol devs' and the game dev's, key sets), whose
// donation rides in its fee locks (fee.js entryFeeBpsOf): what the fee locks hold above the node table is that
// donation, split by `splitDonation` and paid to each key by a pre-expired payout contract, as a walk-away's 25 % is.
function feeSettlement({ entries, feeLocks, signerNodes, contract, fees, feeBps = undefined, donation = null, websitePct = undefined }) {
  const none = { ok: true, claims: [], payouts: [], unpaid: [], poolMsat: 0n, inputFeesMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n, unallocatedMsat: 0n };
  if (!feeLocks.size) return none;
  if (!contract || !signerNodes || !Array.isArray(signerNodes[GAME_VERIFY]) || !Array.isArray(signerNodes[SETTLEMENT]))
    return refuse('fee locks are claimed for the round\'s sitting signer nodes, and no contract or signer nodes were named');
  const counted = entries.filter((e) => !isRefund(e.outcome));
  const claims = [];
  for (const e of counted) {
    const f = feeLocks.get(toHex(e.pubkey));
    if (!f) return refuse(`an entry's fee lock was never verified, so the fee cannot be claimed: ${toHex(e.pubkey).slice(0, 16)}`);
    if (f.amountMsat !== e.feeMsat) return refuse(`a fee lock holds ${f.amountMsat} msat and its entry's fee is ${e.feeMsat}`);
    if (!(f.preimage instanceof Uint8Array) || f.preimage.length !== 32) return refuse('a fee lock is claimed with its F, and that is 32 bytes');
    claims.push({ pubkey: e.pubkey, outpoint: f.outpoint, amountMsat: f.amountMsat, preimage: f.preimage, kind: 'fee' });
  }
  const eligible = new Set([...signerNodes[GAME_VERIFY], ...signerNodes[SETTLEMENT], ...(Array.isArray(signerNodes[GUARDIAN]) ? signerNodes[GUARDIAN] : []),
    ...(Array.isArray(signerNodes[GATEWAY]) ? signerNodes[GATEWAY] : []), ...(Array.isArray(signerNodes[LIQUIDITY]) ? signerNodes[LIQUIDITY] : [])].map(toHex));
  // A CONFLICTED NODE EARNS NO FEE SHARE (§5A.13): its operator plays the round (operator-conflict.js); the
  // caller names them on `signerNodes.conflicted` (hex), and their shares go to the rest of their pool as any absent node's
  for (const k of signerNodes.conflicted || []) eligible.delete(String(k).toLowerCase());
  let table;
  // A VERSION-11 GAME ROUND'S NODES TAKE 4 % (§27A.9.1): its fee locks hold that, and the table owes that
  const rate = feeBps !== undefined ? feeBps : (paysReserves(contract) ? RESERVES_NODE_FEE_BPS : undefined);
  // the liquidity providers' weights (2026.0.16, §23A.10): `signerNodes.liquidityWeights` node hex -> sat, from the standing liquidity seating
  // and, from 2026.0.20 under capacity pressure, the guardians' weights (§23A.3a part 1): `signerNodes.guardianWeights` node hex -> min(bond, B*)^2
  const weights = signerNodes.liquidityWeights instanceof Map || signerNodes.guardianWeights instanceof Map
    ? { ...(signerNodes.liquidityWeights instanceof Map ? { liquidity: signerNodes.liquidityWeights } : {}), ...(signerNodes.guardianWeights instanceof Map ? { guardian: signerNodes.guardianWeights } : {}) } : null;
  try { table = nodeFeeTable({ contract, entries: counted, pools: signerNodes, eligible, weights, ...(rate !== undefined ? { feeBps: rate } : {}) }); } catch (e) { return refuse(e.message); }
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  // A MARKET'S FEE LOCKS HOLD ITS DONATION TOO: the rest above the node table is the donation set's, never the nodes'
  const donationOwedMsat = donation ? poolMsat - table.fee : 0n;
  if (donationOwedMsat < 0n) return refuse(`the fee table owes the signer nodes ${table.fee} msat and the fee locks hold only ${poolMsat}`);
  if (table.fee + donationOwedMsat !== poolMsat) return refuse(`the fee table owes the signer nodes ${table.fee} msat and the fee locks hold ${poolMsat}`);
  if (table.unallocated > 0n) return refuse(`${table.unallocated} msat of the fee has no eligible signer node in its pool, so no fee lock is claimed`);
  let donated = [];
  if (donationOwedMsat > 0n) {
    const split = splitDonation({ donationMsat: donationOwedMsat, recipients: donation.recipients });
    if (!split.owed) return refuse(`the market's donation set does not stand, so no fee lock is claimed: ${split.why}`);
    if (split.shares.some((x) => x.amountMsat > 0n && !(x.recipientPk instanceof Uint8Array)))
      return refuse('a market\'s donation is paid to keys in the federation, and its set names a recipient without one');
    const rid = roundId(contract);
    donated = split.shares.map((x, i) => ({ ...x, id: donationSendId(rid, i), index: i })).filter((x) => x.amountMsat > 0n);
  }
  // ONE PAYOUT PER SIGNER NODE KEY: a signer node in both pools is owed both shares (§22A), paid together. A GUARDIAN SHARE OF A
  // 2026.0.13 ROUND goes to its advert's payout key where the seat names one (`signerNodes.guardianPayout`: node key hex -> 33-byte
  // key, guardian-payout.js): its own output, apart from that node's committee shares.
  const payoutOf = signerNodes.guardianPayout instanceof Map ? signerNodes.guardianPayout : null;
  const owed = new Map();
  for (const [k, msat] of table.signerNodes) {
    const node = k.slice(k.indexOf(':') + 1);
    // a gateway seat's share (2026.0.15, §23A.9) goes where its guardian share goes: its advert's payout key
    // a liquidity provider's share (2026.0.16, §23A.10) too
    const pk = payoutOf && (k.startsWith(`${GUARDIAN}:`) || k.startsWith(`${GATEWAY}:`) || k.startsWith(`${LIQUIDITY}:`)) ? payoutOf.get(node) : null;
    if (pk && !(pk instanceof Uint8Array && pk.length === 33)) return refuse('a guardian is paid to a 33-byte payout key');
    const key = pk ? `payout:${toHex(pk)}` : node;
    owed.set(key, (owed.get(key) || 0n) + msat);
  }
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendable = poolMsat - inputFeesMsat;
  if (spendable <= 0n) return refuse(`the guardians' fees on the fee locks (${inputFeesMsat} msat) take the whole fee of ${poolMsat}`);
  const payouts = [];
  const unpaid = [];
  // THE SERIES PUBLISHER'S FEE BACK (§5A.5publisher-payout.js): one line, off the top of the NODES' part of the fee
  // locks - never the donation's - in the round that pays it: `signerNodes.publisher` { payoutPk, msat }. What the nodes' part
  // can pay, at most the publisher's msat; the nodes share the rest as before.
  const nodePartMsat = (spendable * table.fee) / poolMsat;
  let publisherGross = 0n;
  const pub = signerNodes.publisher;
  if (pub && pub.msat > 0n) {
    if (!(pub.payoutPk instanceof Uint8Array) || pub.payoutPk.length !== 33) return refuse('the series publisher is paid to a 33-byte key');
    const got = largestPayoutMsat(fees, pub.msat + lnv2FeeMsat(fees, pub.msat) < nodePartMsat ? pub.msat + lnv2FeeMsat(fees, pub.msat) : nodePartMsat);
    if (got > 0n) {
      publisherGross = got + lnv2FeeMsat(fees, got);
      payouts.push({ pubkey: pub.payoutPk.subarray(1), payoutPk: pub.payoutPk, owedMsat: pub.msat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: 'publisher' });
    } else unpaid.push({ pubkey: pub.payoutPk.subarray(1), owedMsat: pub.msat, why: 'the publisher\'s fee back does not pay its own output fee' });
  }
  // THE WEBSITE THAT BROUGHT AN ENTRY (2026.0.9RULED path (a)): 20% of the nodes' fee on the stakes it brought,
  // one line per website key, off the top of the NODES' part - never the donation's, never the player's (its stake and fee locks
  // are what they were) - scaled to what the claimed locks pay as the nodes' shares are. The nodes share the rest.
  const sites = frontendShares({ entries: counted, fee: table.fee, gross: table.gross, ...(websitePct !== undefined ? { pct: BigInt(websitePct) } : {}) });
  let frontendGross = 0n;
  for (const [k, siteMsat] of sites.shares) {
    const payoutPk = fromHex(k);
    const got = largestPayoutMsat(fees, (siteMsat * spendable) / poolMsat);
    if (got === 0n) { unpaid.push({ pubkey: payoutPk.subarray(1), owedMsat: siteMsat, why: 'the website\'s share does not pay its own output fee' }); continue; }
    frontendGross += got + lnv2FeeMsat(fees, got);
    payouts.push({ pubkey: payoutPk.subarray(1), payoutPk, owedMsat: siteMsat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: 'frontend' });
  }
  const nodesSpendable = nodePartMsat - publisherGross - frontendGross;
  for (const [key, msat] of owed) {
    const guardianPk = key.startsWith('payout:') ? fromHex(key.slice(7)) : null;
    const pubkey = guardianPk ? guardianPk.subarray(1) : fromHex(key);
    // what this node is owed once the websites' 20% is taken from the nodes' fee (its table share, scaled down by their total)
    const owedMsat = sites.totalMsat ? (msat * (table.fee - sites.totalMsat)) / table.fee : msat;
    const got = largestPayoutMsat(fees, publisherGross || frontendGross ? (msat * nodesSpendable) / table.fee : (msat * spendable) / poolMsat);
    if (got === 0n) { unpaid.push({ pubkey, owedMsat, why: 'its fee share does not pay its own output fee' }); continue; }
    payouts.push({ pubkey, payoutPk: guardianPk || refundKeyOf(pubkey), owedMsat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: guardianPk ? 'guardian payout key' : 'signer node' });
  }
  // THE DONATION'S SHARES, scaled to what the claimed locks pay as the nodes' are, each to its own key
  for (const d of donated) {
    const got = largestPayoutMsat(fees, (d.amountMsat * spendable) / poolMsat);
    if (got === 0n) { unpaid.push({ pubkey: d.id, owedMsat: d.amountMsat, why: `the donation share for ${d.label || 'a key'} does not pay its own output fee` }); continue; }
    payouts.push({ pubkey: d.id, payoutPk: d.recipientPk, owedMsat: d.amountMsat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: 'donation key',
      donation: { id: d.id, index: d.index, recipientPk: d.recipientPk, label: d.label } });
  }
  // A FEE THAT CANNOT REACH A SIGNER NODE IS NOT CLAIMED. Measured under the guardians'
  // real rule (1000 msat per input and per output): two 2000 msat fee locks bring
  // 4000, their inputs cost 2000, and each signer node's 1000 msat share cannot pay its
  // own output - claimed, the players' fees would only have paid the guardians.
  // Left unclaimed, each fee lock expires back to its player; the hole is named.
  if (!payouts.length)
    return { ...none, unpaid, hole: { poolMsat, inputFeesMsat, owedMsat: [...owed.values()].reduce((s, m) => s + m, 0n),
      why: `the fee locks hold ${poolMsat} msat and their inputs alone cost ${inputFeesMsat}: no signer node's share pays its own output, `
        + 'so no fee lock is claimed and each expires back to its player' } };
  const paidMsat = payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = payouts.reduce((s, p) => s + p.feeMsat, 0n);
  return { ok: true, claims, payouts, unpaid, poolMsat, inputFeesMsat, paidMsat, outputFeesMsat,
    unspentMsat: spendable - paidMsat - outputFeesMsat, unallocatedMsat: table.unallocated, hole: null };
}

/**
 * AN ORDER BOOK'S SETTLEMENT (comment 1127; 2026-10-09: "(a)"). `table` is book-ledger.js
 * `bookSettlement` over the certified batches and the final outcome: every entry with a fill, its stake lock (N) and fee
 * lock (F) CLAIMED WHOLE - a lock moves whole, never split - and paid out of in this one transaction: each entry its out
 * (its winnings, less what its sells owe and their fee, plus the rest of its budget and fee it did not spend - a cancelled
 * or partly filled order's rest, a seller's proceeds, all here), the nodes their part of the fees due (`nodeBps` of the
 * market's whole rate, evenly over the round's sitting seats, the msat left to the first), the donation the rest of them
 * (`donation.recipients`, the protocol devs' set and the market dev's, by key). An entry with no fill is not claimed: its
 * locks come back whole by the return door. Under a fee rule that charges, every payout is scaled to what the claimed locks
 * pay after their fees, the dust to the first.
 */
/**
 * THE KEY A MARKET'S RESERVE LINE NAMES UNTIL ITS FEDERATION IS KNOWN: a round that takes any federation is planned
 * once and then split per federation (federation-settlement.js splitByFederation), where each federation's part of the line is
 * paid to that federation's own reserve key. This placeholder is never paid: a split without that key refuses.
 */
export const RESERVE_LATER_PK = Uint8Array.from([0x02, ...new Uint8Array(32)]);

export function bookLockSettlement({ roundId, table, entries, locks, feeLocks, fees, contract, nodeBps, donationBps, donation = null,
  reserveBps = 0, reserveKey = null, websitePct = undefined }) {
  if (!(locks instanceof Map) || !(feeLocks instanceof Map)) return refuse('the verified locks are Maps by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint') return refuse('the guardians\' fee rule is BigInt ppm and base msat');
  if (!table || !Array.isArray(table.claimed)) return refuse('an order book is settled from its settlement table');
  if (!table.claimed.length) return { ok: true, nothing: true, why: 'no order filled: nothing is claimed - every lock comes back whole' };
  const byId = new Map(entries.map((e) => [typeof e.entryId === 'string' ? e.entryId : toHex(e.entryId), e]));
  const claims = [];
  const owed = [];
  for (const r of table.claimed) {
    const e = byId.get(r.entry);
    if (!e) return refuse(`the book names an order this signer node does not hold: ${r.entry.slice(0, 16)}`);
    const lock = locks.get(toHex(e.pubkey));
    const fl = feeLocks.get(toHex(e.pubkey));
    if (!lock) return refuse(`a filled order's stake lock was never verified here: ${r.entry.slice(0, 16)}`);
    if (lock.amountMsat !== r.stakeMsat) return refuse(`a filled order's stake lock holds ${lock.amountMsat} msat and its budget is ${r.stakeMsat}`);
    claims.push({ pubkey: e.pubkey, outpoint: lock.outpoint, amountMsat: lock.amountMsat, kind: 'stake' });
    if (r.feeMsat > 0n) {
      if (!fl) return refuse(`a filled order's fee lock was never verified here: ${r.entry.slice(0, 16)}`);
      if (fl.amountMsat !== r.feeMsat) return refuse(`a filled order's fee lock holds ${fl.amountMsat} msat and its fee is ${r.feeMsat}`);
      if (!(fl.preimage instanceof Uint8Array) || fl.preimage.length !== 32) return refuse('a fee lock is claimed with its F, and that is 32 bytes');
      claims.push({ pubkey: e.pubkey, outpoint: fl.outpoint, amountMsat: fl.amountMsat, preimage: fl.preimage, kind: 'fee' });
    }
    if (r.outMsat > 0n) owed.push({ kind: 'qualifier', pubkey: e.pubkey, payoutPk: lock.refundPk, owedMsat: r.outMsat });
  }
  // THE FEES DUE: the nodes' part of the market's whole rate, the donation the rest
  const total = nodeBps + donationBps;
  let nodesMsat = total > 0 ? (table.feesDueMsat * BigInt(nodeBps)) / BigInt(total) : 0n;
  // THE PROTOCOL RESERVE: `reserveBps` of the whole rate, out of the donation's part - never the nodes' or a player's.
  // Paid to `reserveKey` (the round's federation's reserve key), or to RESERVE_LATER_PK when the round takes any federation
  // and each federation's part goes to its own key
  if (reserveBps > donationBps) return refuse(`a market's protocol reserve (${reserveBps} bps) is part of its donation (${donationBps} bps)`);
  const reserveMsat = reserveBps > 0 && total > 0 ? (table.feesDueMsat * BigInt(reserveBps)) / BigInt(total) : 0n;
  if (reserveMsat > 0n && !(reserveKey instanceof Uint8Array && reserveKey.length === 33)) return refuse('this market pays the protocol reserve, and no reserve key is known for its federation');
  const giftMsat = table.feesDueMsat - nodesMsat - reserveMsat;
  // THE WEBSITE THAT BROUGHT AN ORDER (2026.0.9, comment 2295, path (a)): 20% of the nodes' part of the fee each claimed
  // row paid, to the payout key its entry signed - taken out of the nodes' part, never the donation's or a player's (fee.js
  // frontendBookShares). Its lines go before the seats'.
  const sites = frontendBookShares({ rows: table.claimed, entries: byId, nodeBps, donationBps, ...(websitePct !== undefined ? { pct: BigInt(websitePct) } : {}) });
  if (sites.totalMsat > nodesMsat) return refuse(`the websites' share ${sites.totalMsat} msat is more than the nodes' part ${nodesMsat}`);
  for (const [k, msat] of sites.shares) {
    if (msat <= 0n) continue;
    const payoutPk = fromHex(k);
    owed.push({ kind: 'frontend', pubkey: payoutPk.subarray(1), payoutPk, owedMsat: msat });
  }
  nodesMsat -= sites.totalMsat;
  const sitting = contract && Array.isArray(contract.nodes) ? [...new Map(contract.nodes.map((k) => [toHex(k), k])).values()] : [];
  if (nodesMsat > 0n) {
    if (!sitting.length) return refuse('the nodes\' fee is paid to the round\'s sitting seats, and no contract names them');
    const each = nodesMsat / BigInt(sitting.length);
    sitting.forEach((k, i) => owed.push({ kind: 'signer node', pubkey: k, payoutPk: refundKeyOf(k), owedMsat: each + (i === 0 ? nodesMsat - each * BigInt(sitting.length) : 0n) }));
  }
  if (giftMsat > 0n) {
    if (!donation || !donation.recipients) return refuse('a market\'s donation is paid to its donation target, and this signer node names none');
    const split = splitDonation({ donationMsat: giftMsat, recipients: donation.recipients });
    if (!split.owed) return refuse(`the market's donation set does not stand: ${split.why}`);
    const rid = roundId;
    split.shares.forEach((x, i) => {
      if (x.amountMsat <= 0n) return;
      if (!(x.recipientPk instanceof Uint8Array)) throw new Error('a market\'s donation is paid to keys');
      const sid = donationSendId(rid, i);
      owed.push({ kind: 'donation key', pubkey: sid, payoutPk: x.recipientPk, owedMsat: x.amountMsat, donation: { id: sid, index: i, recipientPk: x.recipientPk, label: x.label } });
    });
  }
  if (reserveMsat > 0n) owed.push({ kind: 'reserve', reserve: true, pubkey: reserveKey.subarray(1), payoutPk: reserveKey, owedMsat: reserveMsat });
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the claimed locks (${inputFeesMsat} msat) take the whole ${poolMsat}`);
  const owedTotal = owed.reduce((s, x) => s + x.owedMsat, 0n);
  if (owedTotal !== poolMsat) return refuse(`the book owes ${owedTotal} msat and the claimed locks hold ${poolMsat}`);
  const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
  const split = owed.map((x) => ({ ...x, msat: largestPayoutMsat(fees, (x.owedMsat * spendableMsat) / poolMsat) }));
  const dust = spendableMsat - split.reduce((s, x) => s + (x.msat > 0n ? gross(x.msat) : 0n), 0n);
  if (dust > 0n && split.length) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);
  const payouts = [];
  const unpaid = [];
  for (const x of split) {
    if (x.msat <= 0n) { unpaid.push({ pubkey: x.pubkey, owedMsat: x.owedMsat, why: 'its share does not pay its own output fee' }); continue; }
    payouts.push({ pubkey: x.pubkey, payoutPk: x.payoutPk, owedMsat: x.owedMsat, msat: x.msat, feeMsat: lnv2FeeMsat(fees, x.msat), kind: x.kind,
      ...(x.donation ? { donation: x.donation } : {}), ...(x.reserve ? { reserve: true } : {}) });
  }
  const paidMsat = payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = payouts.reduce((s, p) => s + p.feeMsat, 0n);
  const unspentMsat = spendableMsat - paidMsat - outputFeesMsat;
  if (unspentMsat < 0n) return refuse('the payouts and their fees come to more than the claimed locks pay for');
  return { ok: true, nothing: false, claims: claims.sort(byOutpoint), payouts: payouts.sort(byPayoutPk), unpaid, forfeits: [],
    nonce: settlementNonce(roundId), stakeWhy: null, poolMsat, inputFeesMsat, spendableMsat, paidMsat, outputFeesMsat, unspentMsat,
    book: { claimed: table.claimed.length, feesDueMsat: table.feesDueMsat, nodesMsat, giftMsat, reserveMsat, websitesMsat: sites.totalMsat },
    // WHAT IT PAID EACH WINNER (measured 2026-10-17: the Up/Down season read 0 wins and a whole loss for every order -
    // a book claims every filled lock, the winners' too, and kept no shares, so a season read 0 paid): each qualifier's out, by its
    // player key - its own stake back and its winnings, as the book paid them
    stakeShares: payouts.filter((p) => p.kind === 'qualifier').map((p) => ({ pubkey: p.pubkey, msat: p.msat })) };
}
