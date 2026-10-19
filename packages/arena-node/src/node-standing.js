// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT IS FALLING BEHIND SAYS SO (§5A.10B, kanban #310). "Everything needed to answer that is public. A node can compute its own
// standing from the chain, with no service to ask":
//   own_weight      its bond, against total bonded capital in its role
//   brackets_served rounds it was eligible for, of the rounds that ran
//   headroom        own bond / bond_min of the largest bracket now common
// and warns "while headroom is still above 1 - at a configured margin, reference 1.5x - and state plainly what would restore it: how
// much more capital". Two warnings apart: FALLING SHARE (the network grows; not a fault, not urgent) and LOSING BRACKETS (bond_min of
// the brackets commonly played has passed, or is near, this node's bond; a bond cannot be topped up - a second bond and 30 days).

/** The bracket "now common": the bond_min most of the recent rounds name; on a tie the larger. */
export function commonBracket(rounds) {
  const n = new Map();
  for (const r of rounds) n.set(String(r.bondMinSats), (n.get(String(r.bondMinSats)) || 0) + 1);
  let best = null;
  for (const [k, c] of n) if (!best || c > best.c || (c === best.c && BigInt(k) > BigInt(best.k))) best = { k, c };
  return best ? BigInt(best.k) : null;
}

/**
 * THIS NODE'S STANDING over recent rounds (newest first): `rounds` [{ atMs, bondMinSats, entries, excluded }] - each round's census
 * (entries with { pubkey hex, bondSats }, and the excluded with theirs where known). `me` this node's key hex; `margin` the headroom
 * a warning starts below. Answers { ownBondSats, ownWeight, bracketsServed, headroom, commonBondMinSats, warnings: [...] }.
 */
export function nodeStanding({ me, rounds, margin = 1.5 }) {
  const mine = (list) => (list || []).find((e) => String(e.pubkey).toLowerCase() === me);
  let own = null;
  for (const r of rounds) { const e = mine(r.entries) || mine(r.excluded); if (e && e.bondSats !== undefined) { own = BigInt(e.bondSats); break; } }
  const weightIn = (r) => {
    const total = (r.entries || []).reduce((t, e) => t + BigInt(e.bondSats || 0n), 0n);
    if (own === null) return null;
    const all = mine(r.entries) ? total : total + own;
    return all > 0n ? Number(own * 1000000n / all) / 1e6 : null;
  };
  const served = rounds.filter((r) => mine(r.entries)).length;
  const common = commonBracket(rounds);
  const headroom = own !== null && common ? Number(own * 1000n / common) / 1000 : null;
  const ownWeight = rounds.length ? weightIn(rounds[0]) : null;
  const oldest = rounds.length ? weightIn(rounds[rounds.length - 1]) : null;
  const warnings = [];
  if (headroom !== null && headroom < margin) {
    const need = BigInt(Math.ceil(Number(common) * margin)) - own;
    warnings.push({ kind: headroom < 1 ? 'losing brackets' : 'near the floor', headroom, urgent: true,
      says: headroom < 1
        ? `this node's bond (${own} sat) is under the bond_min of the rounds now commonly played (${common} sat): it is no longer eligible for them, and its fee income will not lift on its own. `
          + `${need} sat more in a second bond restores ${margin}x headroom - a bond cannot be topped up, and the first stays locked until its maturity.`
        : `headroom ${headroom.toFixed(2)}x, under the ${margin}x margin: the bond_min now common is ${common} sat and this node's bond ${own} sat. `
          + `${need} sat more in a second bond restores ${margin}x, before the floor passes it.` });
  }
  if (ownWeight !== null && oldest !== null && oldest > 0 && ownWeight < oldest * 0.75)
    warnings.push({ kind: 'falling share', urgent: false, from: oldest, to: ownWeight,
      says: `this node's share of the bonded capital fell from ${(oldest * 100).toFixed(1)} % to ${(ownWeight * 100).toFixed(1)} %: the network grew. Not a fault - it is still eligible for everything it was.` });
  return { ownBondSats: own === null ? null : String(own), ownWeight, bracketsServed: { eligible: served, of: rounds.length },
    headroom, commonBondMinSats: common === null ? null : String(common), warnings };
}
