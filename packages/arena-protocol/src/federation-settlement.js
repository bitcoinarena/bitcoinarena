// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SETTLEMENT TRANSACTION PER FEDERATION, ALL FROM ONE PAYOUT TABLE (2026.0.32026-10-13 ~11:45Z: "Es
// muss möglich sein für alle Spiele über alle Federation zu zahlen").
//
// A Fedimint transaction spends and creates notes inside its own federation only, and a round that takes any federation
// (constants.js takesAnyFederation) holds locks in several. So the round's settlement is decided ONCE, as before - who is
// claimed, who is paid what share (lockSettlement, attestedLockSettlement, bookLockSettlement, the remainder split, the fee
// table) - and that one plan is then split into one balanced transaction per federation:
//
//   - each federation's transaction spends exactly the claimed locks that federation holds (stake and fee locks apart, as
//     the plan keeps them apart);
//   - every payout of the plan receives THE SAME FRACTION of every federation's spendable pot - its weight in the plan over
//     the plan's total - so a winner's sum over the federations is its share of the whole round, and nobody is paid out of a
//     pot less than the others; a payout is to a key (the winner's refund key, a node's key, a donation key), and a key is
//     the same in every federation, so the winner's client redeems each part in its own federation (the page sums them);
//   - each federation's guardians' fee rule prices its own inputs and outputs; a part too small to pay its own output fee is
//     not built in that federation and its weight is spread over the rest there; the msat division's dust goes to the
//     first payout of the plan's order in that federation, as lockSettlement does;
//   - each federation's transaction has its own nonce, H(tag || round id || federation id)[0:8], so no two of a round's
//     transactions are the same message to sign.
//
// What it checks, and refuses by name: every claimed lock is in exactly one federation the caller can name; each federation
// has a fee rule; every federation's outputs and their fees come to no more than its inputs pay for; no payout of a
// Lightning send (one invoice, one amount) would be split across federations.
import { lnv2FeeMsat, largestPayoutMsat } from './lock-settlement.js';
import { sha256, toHex } from './hash.js';

const refuse = (why) => ({ ok: false, why });
const NONCE_TAG = new TextEncoder().encode('arena federation settlement v3');
const keyOf = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
const hexOf = (b) => (b instanceof Uint8Array ? toHex(b) : String(b || '')).toLowerCase();

/** One federation's settlement nonce for a round: 8 bytes, the same at every signer node, another per federation. */
export function federationSettlementNonce(roundId, federationId) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  const fid = federationId instanceof Uint8Array ? federationId : Uint8Array.from(Buffer.from(String(federationId), 'hex'));
  if (fid.length !== 32) throw new Error('a federation id is 32 bytes');
  const m = new Uint8Array(NONCE_TAG.length + 64);
  m.set(NONCE_TAG); m.set(roundId, NONCE_TAG.length); m.set(fid, NONCE_TAG.length + 32);
  return sha256(m).subarray(0, 8);
}

/**
 * Split one part (the stake part or the fee part) of a plan over the federations. `claims` [{ outpoint, amountMsat, ... }],
 * `payouts` [{ payoutPk, msat, ... }] - each payout's `msat` in the plan is its weight. Answers per federation id hex
 * { claims, payouts, poolMsat, inputFeesMsat, spendableMsat, paidMsat, outputFeesMsat, unspentMsat, unpaid }.
 */
function splitPart({ claims, payouts, federationOf, feesOf, part, reserveKeyOf = null }) {
  const byFed = new Map();
  for (const c of claims) {
    const fid = federationOf(c.outpoint);
    if (!fid) return refuse(`the ${part} lock at ${keyOf(c.outpoint).slice(0, 20)}… is in no federation this signer node can name`);
    const f = hexOf(fid);
    if (!byFed.has(f)) byFed.set(f, []);
    byFed.get(f).push(c);
  }
  const weightTotal = payouts.reduce((s, p) => s + p.msat, 0n);
  const out = new Map();
  for (const [fid, fc] of byFed) {
    const fees = feesOf(fid);
    if (!fees || typeof fees.ppm !== 'bigint' || typeof fees.baseMsat !== 'bigint') return refuse(`no fee rule for federation ${fid.slice(0, 16)}`);
    const poolMsat = fc.reduce((s, c) => s + c.amountMsat, 0n);
    const inputFeesMsat = fc.reduce((s, c) => s + lnv2FeeMsat(fees, c.amountMsat), 0n);
    const spendableMsat = poolMsat - inputFeesMsat;
    const unpaid = [];
    let paying = payouts.filter((p) => p.msat > 0n);
    if (paying.length && spendableMsat <= 0n) return refuse(`federation ${fid.slice(0, 16)}: its guardians' fees on the ${part} locks (${inputFeesMsat} msat) take the whole ${poolMsat}`);
    let split = [];
    // THE SAME FRACTION OF THIS FEDERATION'S POT TO EVERY PAYOUT; one too small to pay its own output fee here leaves the split
    for (;;) {
      if (!paying.length || weightTotal === 0n) { split = []; break; }
      const w = paying.reduce((s, p) => s + p.msat, 0n);
      split = paying.map((p) => ({ p, msat: largestPayoutMsat(fees, (p.msat * spendableMsat) / w) }));
      const small = split.filter((x) => x.msat === 0n);
      if (!small.length) break;
      for (const x of small) unpaid.push({ pubkey: x.p.pubkey, payoutPk: x.p.payoutPk, federation: fid, why: 'its part in this federation does not pay its own output fee' });
      paying = paying.filter((p) => !small.some((x) => x.p === p));
    }
    // A LIGHTNING SEND IS ONE INVOICE OF ONE AMOUNT: it is never split across federations
    if (byFed.size > 1 && split.some((x) => x.p.sent)) return refuse(`a ${part} payout is a Lightning send of one amount, and the round's locks are in ${byFed.size} federations`);
    const gross = (msat) => msat + lnv2FeeMsat(fees, msat);
    if (split.length) {
      const dust = spendableMsat - split.reduce((s, x) => s + gross(x.msat), 0n);
      if (dust > 0n) split[0].msat = largestPayoutMsat(fees, gross(split[0].msat) + dust);
    }
    const fp = split.map(({ p, msat }) => ({ ...p, owedMsat: p.owedMsat ?? p.msat, weightMsat: p.msat, msat, feeMsat: lnv2FeeMsat(fees, msat) }));
    // A MARKET'S PROTOCOL RESERVE: this federation's part of the reserve line goes to this federation's reserve key
    for (const p of fp) {
      if (!p.reserve) continue;
      const k = typeof reserveKeyOf === 'function' ? reserveKeyOf(fid) : null;
      if (!(k instanceof Uint8Array) || k.length !== 33) return refuse(`federation ${fid.slice(0, 16)} names no reserve key, and this market pays the protocol reserve`);
      p.payoutPk = k; p.pubkey = k.subarray(1);
    }
    const paidMsat = fp.reduce((s, p) => s + p.msat, 0n);
    const outputFeesMsat = fp.reduce((s, p) => s + p.feeMsat, 0n);
    const unspentMsat = spendableMsat - paidMsat - outputFeesMsat;
    if (unspentMsat < 0n) return refuse(`federation ${fid.slice(0, 16)}: the ${part} payouts and their fees come to more than its locks pay for`);
    out.set(fid, { claims: fc, payouts: fp, poolMsat, inputFeesMsat, spendableMsat, paidMsat, outputFeesMsat, unspentMsat, unpaid });
  }
  return { ok: true, byFed: out };
}

/**
 * THE ROUND'S ONE PLAN AS ONE TRANSACTION PER FEDERATION. `plan`: a settlement's answer (lockSettlement and its kin) - its
 * `claims` (stake and fee, `kind`), `payouts`, and `signerNodePayouts` (the fee part's, a subset of `payouts`).
 * `federationOf(outpoint)` -> the federation id (hex or bytes) a claimed lock is in; `feesOf(fidHex)` -> that federation's
 * { ppm, baseMsat }. Answers { ok, settlements: [{ federation, nonce, claims, payouts, ... }] } in federation id order.
 */
export function splitByFederation(plan, { roundId, federationOf, feesOf, reserveKeyOf = null }) {
  if (!plan || !plan.ok) return refuse(plan && plan.why ? plan.why : 'no settlement plan to split');
  if (plan.nothing) return { ok: true, nothing: true, settlements: [] };
  if (typeof federationOf !== 'function' || typeof feesOf !== 'function') return refuse('the federations of the locks and their fee rules are named by the caller');
  const isFee = (c) => c.kind === 'fee';
  // the fee part's payouts are the very objects `finish` lists in both `payouts` and `signerNodePayouts`
  const nodePay = new Set(plan.signerNodePayouts || []);
  const feePayouts = plan.payouts.filter((p) => nodePay.has(p));
  const stakePayouts = plan.payouts.filter((p) => !feePayouts.includes(p));
  const stake = splitPart({ claims: plan.claims.filter((c) => !isFee(c)), payouts: stakePayouts, federationOf, feesOf, part: 'stake', reserveKeyOf });
  if (!stake.ok) return stake;
  const fee = splitPart({ claims: plan.claims.filter(isFee), payouts: feePayouts, federationOf, feesOf, part: 'fee', reserveKeyOf });
  if (!fee.ok) return fee;
  const feds = [...new Set([...stake.byFed.keys(), ...fee.byFed.keys()])].sort();
  const empty = { claims: [], payouts: [], poolMsat: 0n, inputFeesMsat: 0n, spendableMsat: 0n, paidMsat: 0n, outputFeesMsat: 0n, unspentMsat: 0n, unpaid: [] };
  const byOutpoint = (a, b) => (keyOf(a.outpoint) < keyOf(b.outpoint) ? -1 : keyOf(a.outpoint) > keyOf(b.outpoint) ? 1 : 0);
  const byPk = (a, b) => (hexOf(a.payoutPk) < hexOf(b.payoutPk) ? -1 : hexOf(a.payoutPk) > hexOf(b.payoutPk) ? 1 : 0);
  const settlements = feds.map((fid) => {
    const s = stake.byFed.get(fid) || empty; const f = fee.byFed.get(fid) || empty;
    return { federation: fid, nonce: federationSettlementNonce(roundId, fid),
      claims: [...s.claims, ...f.claims].sort(byOutpoint), payouts: [...s.payouts, ...f.payouts].sort(byPk),
      poolMsat: s.poolMsat, inputFeesMsat: s.inputFeesMsat, spendableMsat: s.spendableMsat, paidMsat: s.paidMsat, outputFeesMsat: s.outputFeesMsat, unspentMsat: s.unspentMsat,
      feePoolMsat: f.poolMsat, feePaidMsat: f.paidMsat, feeUnspentMsat: f.unspentMsat, unpaid: [...s.unpaid, ...f.unpaid] };
  });
  return { ok: true, nothing: false, settlements, forfeits: plan.forfeits || [] };
}
