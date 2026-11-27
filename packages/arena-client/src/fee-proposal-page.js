// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEE PROPOSALS ON THE PAGE (2026-10-17: "Proposal type change fees. Any of the fees, all combinations can
// be changed with a proposal"): the fees in force as the testnet's nodes answer them (GET /fees - at a height when asked: a round's
// census height, the set its entry pays and its settlement splits), a proposal built from what the form typed - any subset, refused
// by the very limits and sums the seats enforce (fee-proposal.js feeProposalStands) before anything is signed - and signed by the
// forum's key, handed to every node as a funding proposal is (funding-page.js postFunding, kind 'fee').
import { majorityThenGrace, COMPARE_GRACE_MS, newestCheckedCensus } from './committee.js';
import { seatsOf, seatVoice } from './seat-identity.js';
import { FEES, FEES_TODAY, feeProposalStands, encodeFeeProposal, feeProposalId, roundSplitBps, marketBps } from '../../arena-protocol/src/fee-proposal.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { fundingScheduleFor } from '../../arena-protocol/src/funding.js';
// kanban #3833: one node's /fees answer is read up to a bound, not whole (a ~100 MB inflated body held the paid join); over it = no vote
import { readJsonUpTo } from './item-buy.js';
export const FEES_ANSWER_BYTES_MAX = 8 * 1024 * 1024;

const feesBaseOf = (n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
const feesCurveOf = (curve) => { const c = curve || globalThis.ARENA_CURVE; if (!c || typeof c.pointX !== 'function') throw new Error('no curve loaded (arena-curve.js)'); return c; };

/**
 * THE FEES AS THE NODES ANSWER THEM: every node asked GET /fees (with ?height=H when `height` is given); the set most of them name, kept
 * only when `needed` agree. With `height` the set is the one in force there (`atHeight`), else at each node's tip (`inForce`). Answers
 * { ok, fees, agreeing, asked, tip, limits, sums, schedule, proposals } - `proposals` of an agreeing node - or { ok: false, why }.
 */
// ONE SEAT, ONE VOTE (kanban #3576, audit client-a7-1-3): the URLs of the list were the votes, so a link naming the round's five seats plus six
// paths of one box (http://liar.test/a .. /f) set the round's fees by itself, and every honest seat refused the paid entry built on them. The
// URLs are grouped into seats (seat-identity.js seatsOf: one host one seat unless each of its URLs proves a distinct key of the checked census -
// `keys`, default newestCheckedCensus; `verify`, default the page's curve), a seat's answers are one vote (none when they disagree), and
// `needed` is capped by the seats, not the URLs
const feesVerify = () => { const c = globalThis.ARENA_CURVE; return c && typeof c.verify === 'function' ? (sg, m, k) => { try { return !!c.verify(sg, m, k); } catch { return false; } } : null; };
const feesCensusKeys = () => { const c = newestCheckedCensus(); return c ? c.entries.map((e) => toHex(e.pubkey)) : []; };
export async function fetchFees({ nodes, height = null, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 10000, keys = null, verify = null } = {}) {
  const seats = await seatsOf([...new Set((nodes || []).map(feesBaseOf))], { keys: keys || feesCensusKeys(), verify: verify || feesVerify(), fetcher, ms: timeoutMs });
  const asked = seats.flatMap((s) => s.urls);
  const seatAt = seats.flatMap((s) => s.urls.map(() => s));
  const q = Number.isInteger(height) && height >= 0 ? `?height=${height}` : '';
  // NOT HELD FOR THE SLOWEST NODE (kanban #625, measured 2026-10-24 20:07Z: an order's fetchFees took 10 s - 13 of 14 nodes agreed at
  // once, the 14th was restarting): once more than half the nodes answered, the rest get COMPARE_GRACE_MS more
  const got = new Array(asked.length).fill(null);
  await majorityThenGrace(asked.map(async (b, i) => {
    try { const r = await fetcher(`${b}/fees${q}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); got[i] = r.ok ? await readJsonUpTo(r, FEES_ANSWER_BYTES_MAX) : null; } catch { got[i] = null; }
  }), COMPARE_GRACE_MS);
  const setKey = (a) => (a && (q ? a.atHeight : a.inForce) ? JSON.stringify(Object.keys(FEES).map((f) => (q ? a.atHeight : a.inForce)[f])) : null);
  // (kanban #3576) one answer per seat: the one its URLs agree on
  const answers = seats.map((s) => seatVoice(got.filter((_, i) => seatAt[i] === s), setKey)).filter(Boolean);
  const by = new Map();
  for (const a of answers) { const k = setKey(a); by.set(k, [...(by.get(k) || []), a]); }
  const best = [...by.values()].sort((x, y) => y.length - x.length)[0] || [];
  const need = Math.min(needed, seats.length);
  if (best.length < need || !best.length) return { ok: false, why: `only ${best.length} of ${seats.length} nodes agree on the fees${q ? ` at height ${height}` : ''}, and ${need} must`, asked: seats.length };
  const a = best[0];
  return { ok: true, fees: Object.freeze({ ...(q ? a.atHeight : a.inForce) }), agreeing: best.length, asked: seats.length, tip: a.tip, limits: a.limits, sums: a.sums,
    schedule: a.schedule, proposals: a.proposals || [] };
}

/** The changes a form typed against the fees in force: every fee whose typed whole number differs, in the fees' order. */
export function feeChangesFrom(current, typed) {
  const out = [];
  for (const k of Object.keys(FEES)) {
    if (typed[k] === undefined || typed[k] === null || String(typed[k]).trim() === '') continue;
    const v = Number(typed[k]);
    if (!Number.isInteger(v)) throw new Error(`${k} is a whole number`);
    if (v !== current[k]) out.push({ fee: k, value: v });
  }
  return out;
}

/**
 * A FEE PROPOSAL CHECKED, THEN SIGNED: the same check a seat makes at submission (every limit and every sum of the whole set it makes
 * from `current`, an activation height after its signal and its vote) - a proposal that would be refused is never signed. Answers
 * { ok, id, hex, donations } or { ok: false, why }.
 */
export function signedFeeProposal({ secretKey, networkId, publishedHeight, activationHeight, changes, purpose = '', current = FEES_TODAY, schedule, curve }) {
  const c = feesCurveOf(curve);
  if (!changes || !changes.length) return { ok: false, why: 'change at least one fee' };
  const p = { networkId: fromHex(networkId), author: c.pointX(secretKey), publishedHeight, activationHeight, changes, purpose: String(purpose) };
  // the network's own schedule unless one is given: testnet4 signals and votes a day each (kanban #785)
  const st = feeProposalStands(p, { current, schedule: schedule || fundingScheduleFor(p.networkId) });
  if (!st.ok) return { ok: false, why: st.why };
  const id = feeProposalId(p);
  return { ok: true, id: toHex(id), hex: toHex(Uint8Array.from([...encodeFeeProposal(p), ...c.signSchnorr(id, secretKey)])), donations: st.donations };
}

/** The earliest height a proposal published at `tip` may apply from: after its signal, its vote and the vote's depth. */
export const earliestActivation = (tip, schedule) => tip + schedule.signal + schedule.vote + schedule.decideDepth;

const pctOf = (v, unit) => `${(Number(v) / (unit === 'bps' ? 100 : 1)).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`;
/** A round's fees as a line: "nodes 4 % · developers 4 % · reserves 2 %". */
export const roundFeesLine = (fees) => { const s = roundSplitBps(fees); return `nodes ${pctOf(s.nodes, 'bps')} · developers ${pctOf(s.protocolDevs + s.gameDevs, 'bps')} · reserves ${pctOf(s.reserves, 'bps')}`; };
/** A market's fees as a line: "nodes 0.4 % · developers 0.4 % · reserves 0.2 %". */
export const marketFeesLine = (fees) => `nodes ${pctOf(fees.marketNodeBps, 'bps')} · developers ${pctOf(fees.marketDonationBps, 'bps')} · reserves ${pctOf(fees.marketReserveBps, 'bps')}`;
/** A market's whole rate under a fee set (its fee lock): node + donation + reserve, in bps. */
export const marketFeeBpsOf = (fees) => { const r = marketBps(fees); return r.nodeBps + r.donationBps; };
/** Each fee's unit as the form shows it: bps for rounds and markets, percent for items and the website share. */
export const FEE_UNITS = Object.freeze(Object.fromEntries(Object.keys(FEES).map((k) => [k, /Bps$/.test(k) ? 'bps' : 'pct'])));
