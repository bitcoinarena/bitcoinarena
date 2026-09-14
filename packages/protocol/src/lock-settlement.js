// THE ROUND'S ONE SETTLEMENT OF STAKE LOCKS (FEDERATION.md, money flow step 5;
// W4 - the owner 2026-09-14 07:22: "a loser loses the stake. The lock is claimed
// into the pool. Winners are paid from that.").
//
// THE VERDICT IS THE HOLD PATH'S OWN. `holdSettlement` over one payout table
// decides each entry, so a lock round and a hold round cannot decide the same
// round differently:
//   SETTLE   a loser's stake lock, claimed as an input (`Claim(P)`)
//   CANCEL   a qualifier's own lock, forfeited back to them (forfeit.js, W5b)
//   NOTHING  the lock is left to expire back to its player (VOID, a Delivered run
//            below the score)
// The outputs are one PRE-EXPIRED payout contract per qualifier owed a share:
// `refund_pk` = the key that qualifier's own stake lock names, so only they can
// ever move it (FEDERATION.md source audit, point 2). A qualifier's own stake is
// not in it - that half comes back by the forfeit (`winnings`, as on a hold).
//
// THE GUARDIANS' FEES, AND WHO BEARS THEM. Every input and every output pays
// `base + amount * ppm / 1e6` (lnv2-common config.rs), read from the federation
// (`blwp-stake-lock --mode fees`). They come out of the pool pro rata to what
// each qualifier is owed: target = floor(owed * spendable / pool), then the
// largest payout with payout + fee(payout) <= target. What the floors leave is no
// output and stays with the guardians as fee; a share too small to pay its own
// output fee is reported unpaid, not bumped from anyone else's.
//
// ONE TRANSACTION EVERY SEAT REBUILDS BYTE FOR BYTE: inputs sorted by outpoint,
// payouts by payout key, and the nonce derived from the round id - so the seats
// sign one txid, and a seat signs only the txid it rebuilt itself.
// AND THE FEE LOCKS (Pick A, the owner 2026-09-14): every counted entry's fee lock -
// winners' too, the fee is owed whatever the result (F5) - claimed with its F,
// handed over openly at entry, in the same transaction and the same signature.
// They pay the round's SITTING SEATS by §22A's own weights (`nodeFeeTable`: 1% to
// the game/verify pool, 1% to the settlement pool, per eligible seat, leftovers in
// the round's order), each seat one pre-expired payout contract to its own key -
// never to the donation recipients, and no split invented here. A VOID or
// ENTRY_VOID entry's fee lock is not claimed: §22A's fee base leaves it out.
import { holdSettlement, netStakeMsat, isRefund, SETTLE, CANCEL } from './payout.js';
import { winnings } from './payout-spend.js';
import { nodeFeeTable, GAME_VERIFY, SETTLEMENT } from './fee.js';
import { refundKeyOf } from './stake-lock.js';
import { sha256, toHex, fromHex } from './hash.js';

const refuse = (why) => ({ ok: false, why });
const outpointKey = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;

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

/** The settlement transaction's 8-byte nonce: one per round, the same at every seat. */
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
export function lockSettlement({ roundId, entries, minScore = 0, locks, fees, feeLocks = new Map(), seats = null, contract = null }) {
  if (!(locks instanceof Map)) return refuse('the verified stake locks are a Map by player key');
  if (!(feeLocks instanceof Map)) return refuse('the verified fee locks are a Map by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint' || fees.ppm < 0n || fees.baseMsat < 0n)
    return refuse('the guardians\' fee rule is BigInt ppm and base msat, 0 or more');
  const feePart = feeSettlement({ entries, feeLocks, seats, contract, fees });
  if (!feePart.ok) return feePart;
  // THE STAKE PART'S VERDICT IS THE HOLD PATH'S. A round with losers and nobody to
  // pay is refused there ("the operator would keep ..."), and so its stakes are not
  // claimed here either - but its fee locks still are: the fee is owed.
  let h;
  try { h = holdSettlement({ roundId, entries, minScore }); } catch (e) {
    if (!feePart.claims.length) return refuse(e.message);
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits: [], poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, stakeWhy: e.message }, feePart);
  }

  const lockOf = (e) => locks.get(toHex(e.pubkey));
  const claims = [];
  for (const a of h.actions) {
    if (a.action !== SETTLE) continue;
    const lock = lockOf(a.entry);
    if (!lock) return refuse(`a loser's stake lock was never verified, so it cannot be claimed: ${toHex(a.entry.pubkey).slice(0, 16)}`);
    const net = netStakeMsat(a.entry);
    if (lock.amountMsat !== net)
      return refuse(`a loser's lock holds ${lock.amountMsat} msat and its entry's net stake is ${net}`);
    claims.push({ pubkey: a.entry.pubkey, outpoint: lock.outpoint, amountMsat: net });
  }
  const forfeits = h.actions.filter((a) => a.action === CANCEL).map((a) => a.entry.pubkey);
  if (!claims.length && !feePart.claims.length)
    return { ok: true, nothing: true, why: 'no loser\'s lock is claimed in this round', claims, payouts: [], unpaid: [], forfeits,
      poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n,
      feePoolMsat: 0n, seatPayouts: [], feeClaims: [] };
  if (!claims.length)
    return finish({ roundId, claims: [], payouts: [], unpaid: [], forfeits, poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n,
      stakeWhy: 'no loser\'s lock is claimed in this round' }, feePart);

  const owed = winnings({ table: h.table.table, stakes: h.table.activated });
  if (!owed.ok) return refuse(owed.why);
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  if (owed.owedMsat !== poolMsat)
    return refuse(`the table hands out ${owed.owedMsat} msat and the claimed locks hold ${poolMsat}`);
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendableMsat = poolMsat - inputFeesMsat;
  if (spendableMsat <= 0n) return refuse(`the guardians' fees on the claimed locks (${inputFeesMsat} msat) take the whole pool of ${poolMsat}`);

  const payouts = [];
  const unpaid = [];
  for (const row of owed.rows) {
    const e = h.table.activated.find((x) => toHex(x.pubkey) === toHex(row.pubkey));
    const lock = e && lockOf(e);
    if (!lock) return refuse(`a qualifier's stake lock was never verified, so there is no key to pay: ${toHex(row.pubkey).slice(0, 16)}`);
    const target = (row.msat * spendableMsat) / poolMsat;
    const msat = largestPayoutMsat(fees, target);
    if (msat === 0n) { unpaid.push({ pubkey: row.pubkey, owedMsat: row.msat, why: 'its share does not pay its own output fee' }); continue; }
    payouts.push({ pubkey: row.pubkey, payoutPk: lock.refundPk, owedMsat: row.msat, msat, feeMsat: lnv2FeeMsat(fees, msat) });
  }
  return finish({ roundId, claims: claims.map((c) => ({ ...c, kind: 'stake' })), payouts: payouts.map((p) => ({ ...p, kind: 'qualifier' })),
    unpaid, forfeits, poolMsat, inputFeesMsat, spendableMsat, stakeWhy: null }, feePart);
}

const byOutpoint = (a, b) => (outpointKey(a.outpoint) < outpointKey(b.outpoint) ? -1 : outpointKey(a.outpoint) > outpointKey(b.outpoint) ? 1 : 0);
const byPayoutPk = (a, b) => (toHex(a.payoutPk) < toHex(b.payoutPk) ? -1 : toHex(a.payoutPk) > toHex(b.payoutPk) ? 1 : 0);

/** The stake part and the fee part as ONE transaction: inputs by outpoint, payouts by key, the round's nonce. */
function finish(stake, fee) {
  const claims = [...stake.claims, ...fee.claims].sort(byOutpoint);
  const payouts = [...stake.payouts, ...fee.payouts].sort(byPayoutPk);
  const paidMsat = stake.payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = stake.payouts.reduce((s, p) => s + p.feeMsat, 0n);
  const unspentMsat = stake.spendableMsat - paidMsat - outputFeesMsat;
  if (unspentMsat < 0n) return refuse('the payouts and their fees come to more than the claimed locks pay for');
  if (fee.unspentMsat < 0n) return refuse('the seats\' payouts and their fees come to more than the fee locks pay for');
  return { ok: true, nothing: false, claims, payouts, unpaid: [...stake.unpaid, ...fee.unpaid], forfeits: stake.forfeits,
    nonce: settlementNonce(stake.roundId), stakeWhy: stake.stakeWhy,
    poolMsat: stake.poolMsat, inputFeesMsat: stake.inputFeesMsat, spendableMsat: stake.spendableMsat, paidMsat, outputFeesMsat, unspentMsat,
    feeClaims: fee.claims, seatPayouts: fee.payouts, feePoolMsat: fee.poolMsat, feeInputFeesMsat: fee.inputFeesMsat,
    feePaidMsat: fee.paidMsat, feeOutputFeesMsat: fee.outputFeesMsat, feeUnspentMsat: fee.unspentMsat, feeUnallocatedMsat: fee.unallocatedMsat,
    feeHole: fee.hole || null };
}

/**
 * THE FEE PART: every counted entry's fee lock in, each sitting seat's §22A share
 * out. `seats` names the round's sitting committee by pool ({ gameVerify,
 * settlement }: x-only keys); `feeLocks` the verified fee locks by player key,
 * each with its outpoint, amount and F.
 */
function feeSettlement({ entries, feeLocks, seats, contract, fees }) {
  const none = { ok: true, claims: [], payouts: [], unpaid: [], poolMsat: 0n, inputFeesMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n, unallocatedMsat: 0n };
  if (!feeLocks.size) return none;
  if (!contract || !seats || !Array.isArray(seats[GAME_VERIFY]) || !Array.isArray(seats[SETTLEMENT]))
    return refuse('fee locks are claimed for the round\'s sitting seats, and no contract or seats were named');
  const counted = entries.filter((e) => !isRefund(e.outcome));
  const claims = [];
  for (const e of counted) {
    const f = feeLocks.get(toHex(e.pubkey));
    if (!f) return refuse(`an entry's fee lock was never verified, so the fee cannot be claimed: ${toHex(e.pubkey).slice(0, 16)}`);
    if (f.amountMsat !== e.feeMsat) return refuse(`a fee lock holds ${f.amountMsat} msat and its entry's fee is ${e.feeMsat}`);
    if (!(f.preimage instanceof Uint8Array) || f.preimage.length !== 32) return refuse('a fee lock is claimed with its F, and that is 32 bytes');
    claims.push({ pubkey: e.pubkey, outpoint: f.outpoint, amountMsat: f.amountMsat, preimage: f.preimage, kind: 'fee' });
  }
  const eligible = new Set([...seats[GAME_VERIFY], ...seats[SETTLEMENT]].map(toHex));
  let table;
  try { table = nodeFeeTable({ contract, entries: counted, pools: seats, eligible }); } catch (e) { return refuse(e.message); }
  const poolMsat = claims.reduce((s, c) => s + c.amountMsat, 0n);
  if (table.fee !== poolMsat) return refuse(`the fee table owes the seats ${table.fee} msat and the fee locks hold ${poolMsat}`);
  if (table.unallocated > 0n) return refuse(`${table.unallocated} msat of the fee has no eligible seat in its pool, so no fee lock is claimed`);
  // ONE PAYOUT PER SEAT KEY: a seat in both pools is owed both shares (§22A), paid together.
  const owed = new Map();
  for (const [k, msat] of table.seats) { const key = k.slice(k.indexOf(':') + 1); owed.set(key, (owed.get(key) || 0n) + msat); }
  const inputFeesMsat = claims.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
  const spendable = poolMsat - inputFeesMsat;
  if (spendable <= 0n) return refuse(`the guardians' fees on the fee locks (${inputFeesMsat} msat) take the whole fee of ${poolMsat}`);
  const payouts = [];
  const unpaid = [];
  for (const [key, msat] of owed) {
    const pubkey = fromHex(key);
    const got = largestPayoutMsat(fees, (msat * spendable) / poolMsat);
    if (got === 0n) { unpaid.push({ pubkey, owedMsat: msat, why: 'its fee share does not pay its own output fee' }); continue; }
    payouts.push({ pubkey, payoutPk: refundKeyOf(pubkey), owedMsat: msat, msat: got, feeMsat: lnv2FeeMsat(fees, got), kind: 'seat' });
  }
  // A FEE THAT CANNOT REACH A SEAT IS NOT CLAIMED. Measured under the guardians'
  // real rule (1000 msat per input and per output): two 2000 msat fee locks bring
  // 4000, their inputs cost 2000, and each seat's 1000 msat share cannot pay its
  // own output - claimed, the players' fees would only have paid the guardians.
  // Left unclaimed, each fee lock expires back to its player; the hole is named.
  if (!payouts.length)
    return { ...none, unpaid, hole: { poolMsat, inputFeesMsat, owedMsat: [...owed.values()].reduce((s, m) => s + m, 0n),
      why: `the fee locks hold ${poolMsat} msat and their inputs alone cost ${inputFeesMsat}: no seat's share pays its own output, `
        + 'so no fee lock is claimed and each expires back to its player' } };
  const paidMsat = payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = payouts.reduce((s, p) => s + p.feeMsat, 0n);
  return { ok: true, claims, payouts, unpaid, poolMsat, inputFeesMsat, paidMsat, outputFeesMsat,
    unspentMsat: spendable - paidMsat - outputFeesMsat, unallocatedMsat: table.unallocated, hole: null };
}
