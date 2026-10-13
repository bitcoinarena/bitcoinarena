// THE STAKE CEILING FROM CENSUS HEALTH (§5A.10, kanban #306). "A real-money round must not start unless the eligible population is
// meaningfully larger than the committee. The maximum stake bracket is derived from census health":
//
//   eligible nodes (per role) | total bonded capital (per role) | max bracket
//   < 10                      | any                             | play money only
//   >= 10                     | >= 20 x max_round_pool          | 10 sat
//   >= 15                     | >= 50 x max_round_pool          | 100 sat
//   >= 25                     | >= 100 x max_round_pool         | 1,000 sat
//   >= 50                     | >= 200 x max_round_pool         | contract-defined
//
// max_round_pool is the GROSS volume (§5A.3: "every stake locked, winners' included"): the bracket's stake times max_players_per_round
// (§34, reference 64). "Both quantities are computable by anyone from census_root and the chain, so a client can enforce this rule
// itself and refuse a round whose bracket exceeds what its census supports." Enforced on mainnet (as ruling A of the load rule);
// a test network shows the ceiling and refuses nothing.

import { networkOf } from './constants.js';

export const MAX_PLAYERS_PER_ROUND = 64n;
/** A test network (regtest, testnet4) shows the ceiling and refuses nothing - as ruling A of the load rule (kanban #324). */
export const isTestNetwork = (networkId) => ['regtest', 'testnet4'].includes(networkOf(networkId));
const ROWS = [
  { nodes: 50, times: 200n, bracketSats: null },          // contract-defined: the round's own stake, if the capital holds for it
  { nodes: 25, times: 100n, bracketSats: 1000n },
  { nodes: 15, times: 50n, bracketSats: 100n },
  { nodes: 10, times: 20n, bracketSats: 10n },
];

/**
 * The ceiling one role's census supports, for a round staking `stakeSats`: { ceilingSats (0n = play money only), contractDefined, why }.
 * `nodes` eligible in the role; `bondedSats` their summed bonds.
 */
export function roleCeiling({ nodes, bondedSats, stakeSats, maxPlayers = MAX_PLAYERS_PER_ROUND }) {
  for (const row of ROWS) {
    if (nodes < row.nodes) continue;
    const bracket = row.bracketSats === null ? BigInt(stakeSats) : row.bracketSats;
    if (BigInt(bondedSats) >= row.times * bracket * maxPlayers)
      return { ceilingSats: bracket, contractDefined: row.bracketSats === null,
        why: `${nodes} eligible nodes and ${bondedSats} sat bonded: up to ${row.bracketSats === null ? 'the contract\'s own' : bracket} sat a stake (${row.times}x the gross pool)` };
  }
  return { ceilingSats: 0n, contractDefined: false,
    why: nodes < 10 ? `${nodes} eligible nodes, under 10: play money only` : `${nodes} eligible nodes and ${bondedSats} sat bonded: not 20x a 10 sat bracket's gross pool, play money only` };
}

/**
 * DOES THE CENSUS SUPPORT THIS ROUND'S STAKE? Over both roles (the binding one is the lower): `entries` the census entries ({ roles,
 * bondSats }), `stakeSats` the round's. { ok, ceilingSats, why }.
 */
export function stakeWithinCeiling({ entries, stakeSats, maxPlayers = MAX_PLAYERS_PER_ROUND }) {
  const of = (role) => {
    const es = (entries || []).filter((e) => (e.roles || []).includes(role));
    return roleCeiling({ nodes: es.length, bondedSats: es.reduce((t, e) => t + BigInt(e.bondSats || 0n), 0n), stakeSats, maxPlayers });
  };
  const g = of('game'), s = of('settlement');
  const low = g.ceilingSats <= s.ceilingSats ? g : s;
  const stake = BigInt(stakeSats);
  if (stake === 0n) return { ok: true, ceilingSats: low.ceilingSats, why: 'a free round: no ceiling' };
  const ok = stake <= low.ceilingSats;
  return { ok, ceilingSats: low.ceilingSats, why: ok ? `within the census's ceiling: ${low.why}` : `a ${stake} sat stake is over what this census supports - ${low.why}` };
}
