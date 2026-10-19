// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' APPROVED DONATION SETS, AS A PUBLISHER READS THEM (§27A.4.1, kanban #382): a round must name the set in force at
// its census height, and since the developers' own ballot that may be a set no admin key signed. A publisher (the duty runners,
// the RPS grid runner) reads the ballots from a seat - GET /donation-ballots, every proposal and approval as signed bytes - and
// tallies them itself against the admin key's sets it holds, exactly as the seats and the page do. A seat that does not
// answer leaves the last tally standing.
import { decodeDonationProposal, decodeDonationApproval, approvedDonationSets } from '../../arena-protocol/src/donation-vote.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const split = (hex) => { const b = fromHex(String(hex)); return { body: b.slice(0, -64), signature: b.slice(-64) }; };

/** `ballots` as GET /donation-ballots lists them -> [{ proposal, approvals }] with their signatures. */
export function ballotsFromListing(list) {
  const out = [];
  for (const x of list || []) {
    try {
      const p = split(x.hex);
      out.push({ proposal: { ...decodeDonationProposal(p.body), signature: p.signature },
        approvals: (x.approvals || []).map((h) => { const a = split(h); return { ...decodeDonationApproval(a.body), signature: a.signature }; }) });
    } catch { /* a listing that does not decode is not counted */ }
  }
  return out;
}

/**
 * A KEPT TALLY: `refresh()` asks `seatUrl` and recomputes; `sets()` is the last answer (for donationSetInForce's `approved`).
 * `known` the admin key's sets, `verifySecp256k1(sig, digest, key)`.
 */
export function createApprovedSets({ seatUrl, known, verifySecp256k1, fetcher = fetch, log = () => {} }) {
  let kept = [];
  return {
    sets: () => kept,
    async refresh() {
      let body;
      try { body = await (await fetcher(`${String(seatUrl).replace(/\/+$/, '')}/donation-ballots`, { signal: AbortSignal.timeout(15000) })).json(); }
      catch (e) { return { ok: false, why: e.message, sets: kept.length }; }
      const ballots = ballotsFromListing(body.ballots);
      const nets = [...new Set(ballots.map((b) => toHex(b.proposal.networkId)))];
      const next = [];
      for (const net of nets) {
        const r = await approvedDonationSets({ networkId: fromHex(net), known: known.filter((s) => toHex(s.networkId) === net),
          ballots: ballots.filter((b) => toHex(b.proposal.networkId) === net), verifySecp256k1 });
        next.push(...r.sets);
      }
      if (next.length !== kept.length) log(`[donation-ballot] ${next.length} approved set(s) the developers voted in`);
      kept = next;
      return { ok: true, sets: kept.length, ballots: ballots.length };
    },
  };
}
