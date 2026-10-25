// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROPOSAL THAT CHANGES FEES, ANY OF THEM IN ANY COMBINATION (2026-10-17: "Proposal type change fees. Any of the
// fees, all combinations can be changed with a proposal. Same things apply as usual"; ruled the same day: "Introduce hard limits where
// any parameter could be maliciously used to brick or exploit the game. Approval remains high at current levels. Exclude donation
// split. Exclude slashing. Exclude proposals. Donation amounts and percentages may never be nulled by a proposal, the devs will always
// get a share ... any change to donation percentages requires majority approval by protocol devs"; the limits agreed in comment 3079).
//
//     FeeProposal { network_id, author, published_height, activation_height, changes: [(fee, value)], purpose }   signed by the author
//     FeeApproval { proposal_id, dev, approve }                                                                       signed by a protocol dev
//
// ONE SIGNED FEE SET: a proposal carries any subset of the fees below with their new values. It is checked as a whole - every limit
// and every sum after the change, and a majority of the protocol developers for every donation percentage it changes - and goes the
// funding proposals' way (funding.js): the signal, then the 2-week bond-weighted vote. Accepted, the whole set applies from its
// activation height on; refused, nothing of it applies, not even its valid parts.
//
// OUT OF REACH OF ANY PROPOSAL: the donation's 50/50 split between the protocol and the game developers (donation.js splitTwoSets),
// slashing, every proposal rule, and the pools' split of the node fee (it follows the node fee).
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_FEE_PROPOSAL, TYPE_FEE_APPROVAL, TAG } from './constants.js';
import { FUNDING_SCHEDULES } from './funding.js';

/**
 * THE FEES A PROPOSAL MAY CHANGE, each with its code on the wire, its value today, its hard limit and whether it is a donation (a
 * change needs the protocol developers' majority, and it is never 0). Round and market fees in basis points of a stake; an item's
 * parts and the website's share in percent.
 */
export const FEES = Object.freeze({
  roundNodeBps:      Object.freeze({ code: 1,  today: 400, min: 100, max: 600 }),
  roundDonationBps:  Object.freeze({ code: 2,  today: 400, min: 100, max: 600, donation: true }),
  roundReserveBps:   Object.freeze({ code: 3,  today: 200, min: 50,  max: 400 }),
  itemNodesPct:      Object.freeze({ code: 4,  today: 40,  min: 10,  max: 60 }),
  itemReservesPct:   Object.freeze({ code: 5,  today: 20,  min: 5,   max: 40 }),
  itemDevsPct:       Object.freeze({ code: 6,  today: 40,  min: 10,  max: 100, donation: true }),
  marketNodeBps:     Object.freeze({ code: 7,  today: 40,  min: 10,  max: 100 }),
  marketDonationBps: Object.freeze({ code: 8,  today: 40,  min: 10,  max: 100, donation: true }),
  marketReserveBps:  Object.freeze({ code: 9,  today: 20,  min: 5,   max: 50 }),
  websitePct:        Object.freeze({ code: 10, today: 10,  min: 0,   max: 40 }),   // 20 until 2026-10-25 (kanban #675)
});
/** The sums the set must keep: a round at most 10 %, an item's parts exactly 100 %, a market at most 2 %. */
export const ROUND_TOTAL_MAX_BPS = 1000, ITEM_TOTAL_PCT = 100, MARKET_TOTAL_MAX_BPS = 200;
/** The fees in force before any proposal. */
export const FEES_TODAY = Object.freeze(Object.fromEntries(Object.entries(FEES).map(([k, f]) => [k, f.today])));
const BY_CODE = new Map(Object.entries(FEES).map(([k, f]) => [f.code, k]));
export const FEE_PURPOSE_MAX = 4000;

const feeIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * THE SET AS A WHOLE: every fee inside its limit, and the round, item and market sums. Answers { ok } or { ok: false, why } naming the
 * first that does not hold.
 */
export function feeSetStands(set) {
  for (const [k, f] of Object.entries(FEES)) {
    const v = set[k];
    if (!Number.isInteger(v)) return { ok: false, why: `the fee set names no ${k}` };
    if (v < f.min || v > f.max) return { ok: false, why: `${k} is ${v}, outside its limit ${f.min}..${f.max}` };
  }
  const round = set.roundNodeBps + set.roundDonationBps + set.roundReserveBps;
  if (round > ROUND_TOTAL_MAX_BPS) return { ok: false, why: `a round's fees come to ${round} bps, above the ${ROUND_TOTAL_MAX_BPS} bps (10 %) a round may take` };
  const item = set.itemNodesPct + set.itemReservesPct + set.itemDevsPct;
  if (item !== ITEM_TOTAL_PCT) return { ok: false, why: `an item's nodes, reserves and developers' parts come to ${item} %, not ${ITEM_TOTAL_PCT} %` };
  const market = set.marketNodeBps + set.marketDonationBps + set.marketReserveBps;
  if (market > MARKET_TOTAL_MAX_BPS) return { ok: false, why: `a market's fees come to ${market} bps, above the ${MARKET_TOTAL_MAX_BPS} bps (2 %) a market may take` };
  return { ok: true };
}

/** The set `base` with the proposal's changes applied: { ...base, fee: value }. */
export const applyFeeChanges = (base, changes) => Object.freeze({ ...base, ...Object.fromEntries(changes.map((c) => [c.fee, c.value])) });

export function encodeFeeProposal(p) {
  if (!feeIs32(p.networkId) || !feeIs32(p.author)) throw new Error('a fee proposal names its network and its author by 32 bytes each');
  if (!Number.isInteger(p.publishedHeight) || p.publishedHeight < 0) throw new Error('published_height is a block height');
  if (!Number.isInteger(p.activationHeight) || p.activationHeight <= p.publishedHeight) throw new Error('a fee proposal applies from a height after its publication');
  if (!Array.isArray(p.changes) || !p.changes.length) throw new Error('a fee proposal changes at least one fee');
  const seen = new Set();
  for (const c of p.changes) {
    if (!FEES[c.fee]) throw new Error(`no proposal changes "${c.fee}": the fees a proposal may change are ${Object.keys(FEES).join(', ')}`);
    if (seen.has(c.fee)) throw new Error(`a fee proposal names ${c.fee} once`);
    if (!Number.isInteger(c.value) || c.value < 0 || c.value > 65535) throw new Error(`${c.fee} is a whole number`);
    seen.add(c.fee);
  }
  if (typeof p.purpose !== 'string' || p.purpose.length > FEE_PURPOSE_MAX) throw new Error(`a fee proposal says why in at most ${FEE_PURPOSE_MAX} characters`);
  const w = new Writer();
  w.u8(TYPE_FEE_PROPOSAL); w.u16(PROTOCOL_VERSION);
  w.bytes32(p.networkId); w.bytes32(p.author); w.u32(p.publishedHeight); w.u32(p.activationHeight);
  const byCode = (a, b) => FEES[a.fee].code - FEES[b.fee].code;                // one encoding whatever order they were named in
  w.vec([...p.changes].sort(byCode), (c, ww) => { ww.u8(FEES[c.fee].code); ww.u16(c.value); }, { sortedBy: byCode });
  w.str(p.purpose);
  return w.finish();
}
export function decodeFeeProposal(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FEE_PROPOSAL) throw new Error('not a fee proposal');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { networkId: r.bytes32(), author: r.bytes32(), publishedHeight: r.u32(), activationHeight: r.u32(),
    changes: r.vec((rr) => { const code = rr.u8(), value = rr.u16(); const fee = BY_CODE.get(code); if (!fee) throw new Error(`no fee has code ${code}`); return { fee, value }; }),
    purpose: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the fee proposal');
  encodeFeeProposal(p);                       // the same rules on the way in
  return p;
}
export const feeProposalId = (p) => taggedHash(TAG.feeProposal, encodeFeeProposal(p));

export function encodeFeeApproval(a) {
  if (!feeIs32(a.proposalId) || !feeIs32(a.dev)) throw new Error('a fee approval names its proposal and its protocol developer by 32 bytes each');
  const w = new Writer();
  w.u8(TYPE_FEE_APPROVAL); w.u16(PROTOCOL_VERSION);
  w.bytes32(a.proposalId); w.bytes32(a.dev); w.u8(a.approve ? 1 : 0);
  return w.finish();
}
export function decodeFeeApproval(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FEE_APPROVAL) throw new Error('not a fee approval');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const a = { proposalId: r.bytes32(), dev: r.bytes32(), approve: r.u8() === 1 };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the fee approval');
  return a;
}
export const feeApprovalId = (a) => taggedHash(TAG.feeApproval, encodeFeeApproval(a));

/** The donation fees a proposal changes against `current`: those whose value it moves. */
export const donationChanges = (p, current) => p.changes.filter((c) => FEES[c.fee].donation && c.value !== current[c.fee]).map((c) => c.fee);

/**
 * AT SUBMISSION (a seat keeps it, the page offers it): its encoding, and the whole set it makes from the fees in force (`current`)
 * standing - no limit broken, no sum broken, no donation nulled - and an activation height after its vote can be decided
 * (published + signal + vote + decideDepth). Answers { ok, fees, donations } or { ok: false, why }.
 */
export function feeProposalStands(p, { current = FEES_TODAY, schedule = FUNDING_SCHEDULES.spec } = {}) {
  try { encodeFeeProposal(p); } catch (e) { return { ok: false, why: e.message }; }
  const fees = applyFeeChanges(current, p.changes);
  const st = feeSetStands(fees);
  if (!st.ok) return st;
  const earliest = p.publishedHeight + schedule.signal + schedule.vote + schedule.decideDepth;
  if (p.activationHeight < earliest) return { ok: false, why: `a fee proposal published at ${p.publishedHeight} applies from ${earliest} at the earliest, after its signal and its vote` };
  return { ok: true, fees, donations: donationChanges(p, current) };
}

/**
 * THE PROTOCOL DEVELOPERS' ANSWER: more than half of `devKeys` (32-byte hex) approve it, each counted once, by a signature
 * `verify(signature, id, key)` checks. `approvals` [{ approval: { proposalId, dev, approve }, signature }].
 */
export function devMajority({ proposalId, approvals = [], devKeys = [], verify }) {
  const keys = new Set(devKeys.map((k) => String(k).toLowerCase()));
  const said = new Map();
  for (const x of approvals) {
    const a = x.approval;
    if (!a || toHex(a.proposalId) !== toHex(proposalId) || !keys.has(toHex(a.dev))) continue;
    let good = false; try { good = verify(x.signature, feeApprovalId(a), a.dev) === true; } catch { good = false; }
    if (good) said.set(toHex(a.dev), a.approve);
  }
  const yes = [...said.values()].filter(Boolean).length;
  return { yes, no: said.size - yes, of: keys.size, majority: keys.size > 0 && yes * 2 > keys.size };
}

/**
 * THE OUTCOME OF ONE FEE PROPOSAL, AS A WHOLE: accepted only when its set stands against the fees in force (`current`), its signal
 * passed (funding.js signalOutcome), its vote passed (fundingTally) and - when it changes a donation percentage - the protocol
 * developers' majority approves it. Answers { accepted: true, fees, activationHeight } or { accepted: false, why }: a refusal applies
 * nothing.
 */
export function feeProposalOutcome({ proposal, current = FEES_TODAY, signal, tally, approvals = [], devKeys = [], verify, schedule = FUNDING_SCHEDULES.spec }) {
  const st = feeProposalStands(proposal, { current, schedule });
  if (!st.ok) return { accepted: false, why: st.why };
  if (!signal || signal.state !== 'passed') return { accepted: false, why: 'its signal did not pass' };
  if (!tally || tally.passed !== true) return { accepted: false, why: 'its vote did not pass' };
  if (st.donations.length) {
    const dm = devMajority({ proposalId: feeProposalId(proposal), approvals, devKeys, verify });
    if (!dm.majority) return { accepted: false, why: `it changes ${st.donations.join(', ')}, and ${dm.yes} of ${dm.of} protocol developers approve it - a majority must` };
  }
  return { accepted: true, fees: st.fees, activationHeight: proposal.activationHeight };
}

/** THE FEES IN FORCE AT A HEIGHT: the latest accepted set whose activation height is at or below it, else `base`. */
export function feesAt({ height, accepted = [], base = FEES_TODAY }) {
  let at = null;
  for (const a of accepted) if (a && a.accepted !== false && Number.isInteger(a.activationHeight) && a.activationHeight <= height && (!at || a.activationHeight >= at.activationHeight)) at = a;
  return at ? at.fees : base;
}

/** A round's split from a fee set, in bps of the gross stake: the donation half protocol developers (floored), half game. */
export function roundSplitBps(fees) {
  const protocolDevs = Math.floor(fees.roundDonationBps / 2);
  return { nodes: fees.roundNodeBps, protocolDevs, gameDevs: fees.roundDonationBps - protocolDevs, reserves: fees.roundReserveBps };
}
/** A market's rates from a fee set, as bookLockSettlement takes them: the reserve inside the donation's part. */
export const marketBps = (fees) => ({ nodeBps: fees.marketNodeBps, donationBps: fees.marketDonationBps + fees.marketReserveBps, reserveBps: fees.marketReserveBps });
