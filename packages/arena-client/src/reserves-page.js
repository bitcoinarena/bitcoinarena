// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL RESERVES ON THE PAGE (§27A.9): a version-11 round's entry pays the developers' 4 % and the
// reserves' 2 % - mandatory, not the player's donation choice - and locks the reserves' part to its federation's 5-of-7 reserve
// key. The key is read from the round's signer nodes (GET /reserves), and taken only when at least `needed` of them name the
// same one for that federation: no single seat can point the reserves somewhere else.
import { roundSplit, ROUND_SPLIT_BPS } from '../../arena-protocol/src/reserves.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { stakeOf } from './join.js';

export async function fetchReserveKey({ federationId, nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 8000 } = {}) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) return { ok: false, why: 'the round names no federation to pay the reserves in' };
  const fed = toHex(federationId);
  const said = new Map();
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  await Promise.all(asked.map(async (base) => {
    try {
      const r = await fetcher(`${base}/reserves`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const f = ((await r.json()).federations || []).find((x) => x.federationId === fed && /^0[23][0-9a-f]{64}$/.test(String(x.key || '')));
      if (f) said.set(f.key, (said.get(f.key) || 0) + 1);
    } catch { /* a node that does not answer names nothing */ }
  }));
  const best = [...said.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return { ok: false, why: `none of the round's ${asked.length} signer nodes names a reserve key for federation ${fed.slice(0, 8)}` };
  if (best[1] < needed) return { ok: false, why: `only ${best[1]} of the round's signer nodes name reserve key ${best[0].slice(0, 16)}, and ${needed} must` };
  return { ok: true, key: fromHex(best[0]), agreeing: best[1], asked: asked.length };
}

/** What a version-11 entry gives beside its stake: { bps, donationMsat, reserveMsat, mandatory } - the developers' 4 % and the reserves' 2 %. */
// `split`: the round's split in force at its census height (fee-proposal.js roundSplitBps); unset, today's
export function reservesDonation(stakeMsat, split = ROUND_SPLIT_BPS) {
  const s = roundSplit(BigInt(stakeMsat), { split });
  return { bps: split.protocolDevs + split.gameDevs + split.reserves, donationMsat: s.protocolDevsMsat + s.gameDevsMsat + s.reservesMsat, reserveMsat: s.reservesMsat, mandatory: true };
}

/** The same for a round as the page holds it (its stake as the join reads it, stakeOf), at the fees in force there (`round.feeSet`). */
export const reservesDonationForRound = (round) => reservesDonation(stakeOf(round), round && round.feeSet ? roundSplitBps(round.feeSet) : ROUND_SPLIT_BPS);

/**
 * THE RESERVES' TOTAL ON THE PAGE (§27A.9.2,: "testnet.bitcoin-arena.io shows the total and the latest
 * payments in"): GET /reserves on the network's nodes; a total is shown only when at least `needed` of them answer the same one,
 * and its payments in are those nodes' own list, newest first. Answers { ok, totalMsat, entries, paidIn, agreeing, asked } or why not.
 */
export async function fetchReservesTotal({ nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 8000 } = {}) {
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  const by = new Map();
  await Promise.all(asked.map(async (base) => {
    try {
      const r = await fetcher(`${base}/reserves`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const j = await r.json();
      if (!/^\d+$/.test(String(j.totalMsat ?? ''))) return;
      const k = String(j.totalMsat);
      const had = by.get(k) || { n: 0, answer: j };
      had.n++; by.set(k, had);
    } catch { /* a node that does not answer names nothing */ }
  }));
  const best = [...by.entries()].sort((a, b) => b[1].n - a[1].n || (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1))[0];
  if (!best) return { ok: false, why: `none of ${asked.length} nodes answered the reserves`, asked: asked.length };
  if (best[1].n < needed) return { ok: false, why: `only ${best[1].n} of ${asked.length} nodes name the same reserves, and ${needed} must`, asked: asked.length };
  const a = best[1].answer;
  return { ok: true, totalMsat: BigInt(best[0]), entries: Number(a.entries) || 0, paidIn: Array.isArray(a.paidIn) ? a.paidIn : [], agreeing: best[1].n, asked: asked.length };
}

// THE PAYMENTS OUT OF THE RESERVES ON THE PAGE (§27A.9.32026-10-17: "Yes. I agree with the payments-out plan"):
// each node's payout records (GET /reserve-payouts) and its proposals with their votes (GET /funding). A payment out is shown only
// when `needed` nodes list the same record, and - unless it is a drained federation's move, which no vote decides - only when as
// many of them hold its proposal's bond-weighted vote as passed; a payout without that is never a payment here, it is an
// inconsistency. A passed vote with no payout shown is listed as pending, so a passed vote is never silently missing.
const OUT_STATUS = { PAID: 'paid', SENT: 'sent', REFUNDED: 'refunded to the reserves', SHORT: 'short', CLAIMED: 'moved' };
const recordTag = (x) => { const p = x.plan || {};
  return JSON.stringify([String(x.proposal || '').toLowerCase(), x.state, p.kind || 'payout', String(x.federation || '').toLowerCase(), p.to || null, String(p.amountSats ?? ''),
    p.lnurl || null, x.txid || null, x.preimage || null, x.refundTxid || null, x.claimTxid || null]); };

/**
 * What the nodes' answers agree on. `answers` [{ payouts: [...] (GET /reserve-payouts), proposals: [...] (GET /funding) }], one per node
 * that answered both. Answers { ok, out: [{ kind, proposal, purpose, lnurl, to, federation, amountSats, status, vote, preimage, txid,
 * agreeing }], pending: [{ proposal, purpose, lnurl, amountSats, vote }], inconsistent: [{ proposal, why }], agreeing, asked } or why not.
 */
export function reservesPaymentsOut({ answers, needed = 5, asked = answers.length }) {
  if (answers.length < needed) return { ok: false, why: `only ${answers.length} of ${asked} nodes answered the payments out, and ${needed} must`, asked };
  const recs = new Map(), passed = new Map(), info = new Map(), sets = new Map();
  for (const a of answers) {
    const mine = new Set();
    for (const x of a.payouts || []) { const t = recordTag(x); if (mine.has(t)) continue; mine.add(t);
      const had = recs.get(t) || { n: 0, x }; had.n++; recs.set(t, had); }
    const fp = [...mine].sort().join('|'); sets.set(fp, (sets.get(fp) || 0) + 1);
    for (const p of a.proposals || []) {
      const id = String(p.id || '').toLowerCase();
      if (!info.has(id)) info.set(id, p);
      if (!(p.vote && p.vote.state === 'passed')) continue;
      const c = p.vote.count || {};
      const t = JSON.stringify([id, c.turnoutPct ?? null, c.approvalPct ?? null]);
      const had = passed.get(t) || { n: 0, id, turnoutPct: c.turnoutPct ?? null, yesPct: c.approvalPct ?? null }; had.n++; passed.set(t, had);
    }
  }
  const votes = new Map();
  for (const v of passed.values()) if (v.n >= needed && !votes.has(v.id)) votes.set(v.id, { turnoutPct: v.turnoutPct, yesPct: v.yesPct, agreeing: v.n });
  const out = [], inconsistent = [], paidFor = new Set();
  for (const { n, x } of recs.values()) {
    if (n < needed) continue;
    const p = x.plan || {}, id = String(x.proposal || '').toLowerCase(), move = p.kind === 'move';
    if (x.state === 'PLANNED') continue;
    const vote = move ? null : votes.get(id);
    if (!move && !vote) { inconsistent.push({ proposal: id, why: `${n} nodes list a payout (${x.state}) for proposal ${id.slice(0, 8)}, and its vote has not passed on ${needed} of them` }); continue; }
    const prop = info.get(id) || {};
    if (!move) paidFor.add(id);
    out.push({ kind: move ? 'move' : 'payout', proposal: id, purpose: move ? `moved from federation ${String(x.federation || '').slice(0, 8)}` : (prop.purpose || ''),
      lnurl: move ? null : (p.lnurl || prop.lnurl || null), to: move ? String(p.to || '') : null, federation: String(x.federation || ''),
      amountSats: String(p.amountSats ?? prop.amountSats ?? ''), status: OUT_STATUS[x.state] || String(x.state).toLowerCase(), vote,
      preimage: x.preimage || null, txid: x.claimTxid || x.txid || null, agreeing: n });
  }
  const pending = [...votes.entries()].filter(([id]) => !paidFor.has(id)).map(([id, vote]) => { const p = info.get(id) || {};
    return { proposal: id, purpose: p.purpose || '', lnurl: p.lnurl || null, amountSats: String(p.amountSats ?? ''), vote }; });
  return { ok: true, out, pending, inconsistent, agreeing: Math.max(0, ...sets.values()), asked };
}

/** The same, from the network's nodes: GET /reserve-payouts and GET /funding on each; a node that does not answer both counts for nothing. */
export async function fetchReservesPaymentsOut({ nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 8000 } = {}) {
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  const got = await Promise.all(asked.map(async (base) => {
    try {
      const [a, b] = await Promise.all(['/reserve-payouts', '/funding'].map((p) => fetcher(`${base}${p}`, { signal: AbortSignal.timeout(timeoutMs) })));
      if (!a.ok || !b.ok) return null;
      const [x, y] = [await a.json(), await b.json()];
      return Array.isArray(x.payouts) && Array.isArray(y.proposals) ? { payouts: x.payouts, proposals: y.proposals } : null;
    } catch { return null; }
  }));
  return reservesPaymentsOut({ answers: got.filter(Boolean), needed, asked: asked.length });
}

/** One line per payment out, as the page lists it. */
export function paymentOutLine(o) {
  const vote = o.vote ? ` · vote ${o.vote.turnoutPct} % turnout, ${o.vote.yesPct} % YES` : '';
  const proof = o.preimage ? ` · preimage ${String(o.preimage).slice(0, 16)}…` : '';
  const tx = o.txid ? ` · tx ${String(o.txid).slice(0, 16)}…` : '';
  if (o.kind === 'move') return `${o.purpose} to federation ${String(o.to).slice(0, 8)} · ${Number(o.amountSats).toLocaleString('en-US')} sat · ${o.status}${tx}`;
  return `${o.purpose} · ${o.lnurl} · ${Number(o.amountSats).toLocaleString('en-US')} sat · ${o.status}${vote}${proof}${tx}`;
}
