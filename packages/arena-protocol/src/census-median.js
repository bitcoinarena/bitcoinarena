// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SELF-BINDING SCALARS: A MEDIAN, NOT A BALLOT (§27A.2). "Every node declares its preferred value for each qualifying scalar
// in its NodeAdvertisement. The value in force for a round is the bond-weighted median over the census at census_height ... There is no
// proposal, no voting period, no quorum, no tally" - a pure function of chain state. Qualifying: bond_min and proposal_deposit_sats
// ("declaring it must bind the declarer"); node_fee_bps is not one (§27A.7).

export const DECLARED_SCALARS = Object.freeze(['bondMinSats', 'proposalDepositSats']);
/**
 * THE BOND_MIN A NODE THAT DECLARES NOTHING COUNTS AT (kanban #2686, protocol 30), per network: 50 000 sat - what testnet4's rounds name
 * and every seat's census floor reads (main.js, ARENA_LOWEST_BOND_MIN_SATS unset). A protocol value, never a seat's setting.
 */
export const BOND_MIN_DEFAULT_SATS = Object.freeze({ regtest: 50000n, testnet4: 50000n, mainnet: 50000n });
export const bondMinDefaultSats = (network) => (Object.prototype.hasOwnProperty.call(BOND_MIN_DEFAULT_SATS, network) ? BOND_MIN_DEFAULT_SATS[network] : BOND_MIN_DEFAULT_SATS.mainnet);

/**
 * THE BOND-WEIGHTED MEDIAN of `field` over census entries ({ bondSats, advert: { declares } }): the declared values sorted, each weighted
 * by its node's bond, the first whose cumulative weight reaches half the total. Nodes declaring nothing do not count. null with none.
 */
// `undeclared` (kanban #2686, protocol 30): the value a node that declares nothing counts at - its whole bond weighs, so no minority of
// the weight moves the median alone. Not given: such a node does not count (the rule below protocol 30, byte for byte).
export function bondWeightedMedian(entries, field, { undeclared = null } = {}) {
  if (!DECLARED_SCALARS.includes(field)) throw new Error(`${field} is not a self-binding scalar (§27A.2)`);
  const declared = (e) => e && e.advert && e.advert.declares && typeof e.advert.declares[field] === 'bigint';
  const xs = (entries || []).filter((e) => e && BigInt(e.bondSats || 0n) > 0n && (declared(e) || typeof undeclared === 'bigint'))
    .map((e) => ({ v: declared(e) ? e.advert.declares[field] : undeclared, w: BigInt(e.bondSats) })).sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  if (!xs.length) return null;
  const total = xs.reduce((t, x) => t + x.w, 0n);
  let run = 0n;
  for (const x of xs) { run += x.w; if (run * 2n >= total) return x.v; }
  return xs[xs.length - 1].v;
}
