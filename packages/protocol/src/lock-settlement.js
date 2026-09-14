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
import { holdSettlement, netStakeMsat, SETTLE, CANCEL } from './payout.js';
import { winnings } from './payout-spend.js';
import { sha256, toHex } from './hash.js';

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
export function lockSettlement({ roundId, entries, minScore = 0, locks, fees }) {
  if (!(locks instanceof Map)) return refuse('the verified stake locks are a Map by player key');
  if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint' || fees.ppm < 0n || fees.baseMsat < 0n)
    return refuse('the guardians\' fee rule is BigInt ppm and base msat, 0 or more');
  let h;
  try { h = holdSettlement({ roundId, entries, minScore }); } catch (e) { return refuse(e.message); }

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
  if (!claims.length)
    return { ok: true, nothing: true, why: 'no loser\'s lock is claimed in this round', claims, payouts: [], unpaid: [], forfeits,
      poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n };

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
  claims.sort((a, b) => (outpointKey(a.outpoint) < outpointKey(b.outpoint) ? -1 : outpointKey(a.outpoint) > outpointKey(b.outpoint) ? 1 : 0));
  payouts.sort((a, b) => (toHex(a.payoutPk) < toHex(b.payoutPk) ? -1 : toHex(a.payoutPk) > toHex(b.payoutPk) ? 1 : 0));
  const paidMsat = payouts.reduce((s, p) => s + p.msat, 0n);
  const outputFeesMsat = payouts.reduce((s, p) => s + p.feeMsat, 0n);
  const unspentMsat = spendableMsat - paidMsat - outputFeesMsat;
  if (unspentMsat < 0n) return refuse('the payouts and their fees come to more than the claimed locks pay for');
  return { ok: true, nothing: false, claims, payouts, unpaid, forfeits, nonce: settlementNonce(roundId),
    poolMsat, inputFeesMsat, spendableMsat, paidMsat, outputFeesMsat, unspentMsat };
}
