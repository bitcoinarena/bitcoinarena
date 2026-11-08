// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE STAKE CEILING FROM CENSUS HEALTH (§5A.10). "A real-money round must not start unless the eligible population is
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
import { entryFeeMsat, NODE_FEE_BPS } from './fee.js';

export const MAX_PLAYERS_PER_ROUND = 64n;
/** A test network (regtest, testnet4) shows the ceiling and refuses nothing - as ruling A of the load rule. */
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
 * THE INCOME TERM (§5A.10 RULED 2026-11-07, kanban #1280/#1282): "max_round_pool <= income_seat ... (the lower of this and the table wins)" -
 * income_seat = the nodes' fee of every round that counted for the season over the last `season` blocks, ÷ the census size at the round's census height.
 * `rounds` the counted rounds ({ void, entries: [{ stakeMsat }] }, the season book's), `feeBpsOf(round)` the node fee each was charged (NODE_FEE_BPS
 * unless a fee proposal changed it). Answers sat; 0 for a network with no counted round or an empty census.
 */
export const INCOME_SEASON_BLOCKS = 12960;
export function incomeSeatSats({ rounds = [], censusSize, feeBpsOf = () => NODE_FEE_BPS }) {
  if (!(Number(censusSize) > 0)) return 0n;
  let fee = 0n;
  for (const r of rounds || []) { if (!r || r.void) continue; for (const e of r.entries || []) fee += entryFeeMsat(BigInt(e.stakeMsat || 0n), feeBpsOf(r)); }
  return fee / 1000n / BigInt(censusSize);
}
/** The lowest bracket (10 sat): a network whose income term is under it plays it - "a network with no season behind it ... plays the table's lowest bracket". */
export const LOWEST_BRACKET_SATS = 10n;
/** A stake ceiling bounded by the income term: min(table, max(lowest bracket, income_seat ÷ players)); `incomeSats` null leaves the table's. Play money (0) stays 0. */
export function ceilingWithIncome({ ceilingSats, incomeSats = null, maxPlayers = MAX_PLAYERS_PER_ROUND }) {
  const c = BigInt(ceilingSats);
  if (incomeSats === null || incomeSats === undefined || c === 0n) return c;
  const byIncome = BigInt(incomeSats) / BigInt(maxPlayers);
  const bound = byIncome > LOWEST_BRACKET_SATS ? byIncome : LOWEST_BRACKET_SATS;
  return c < bound ? c : bound;
}

/**
 * DOES THE CENSUS SUPPORT THIS ROUND'S STAKE? Over both roles (the binding one is the lower): `entries` the census entries ({ roles,
 * bondSats }), `stakeSats` the round's. { ok, ceilingSats, why }.
 */
// `incomeSats` (kanban #1282): the income term's income_seat, which bounds the table's bracket (ceilingWithIncome); null: the table alone, as before
export function stakeWithinCeiling({ entries, stakeSats, maxPlayers = MAX_PLAYERS_PER_ROUND, incomeSats = null }) {
  const of = (role) => {
    const es = (entries || []).filter((e) => (e.roles || []).includes(role));
    return roleCeiling({ nodes: es.length, bondedSats: es.reduce((t, e) => t + BigInt(e.bondSats || 0n), 0n), stakeSats, maxPlayers });
  };
  const g = of('game'), s = of('settlement');
  const low0 = g.ceilingSats <= s.ceilingSats ? g : s;
  const bounded = ceilingWithIncome({ ceilingSats: low0.ceilingSats, incomeSats, maxPlayers });
  const low = bounded === low0.ceilingSats ? low0 : { ceilingSats: bounded, why: `${low0.why}; bounded by the income term: ${incomeSats} sat a seat earned in the season, so up to ${bounded} sat a stake (§5A.10)` };
  const stake = BigInt(stakeSats);
  if (stake === 0n) return { ok: true, ceilingSats: low.ceilingSats, why: 'a free round: no ceiling' };
  const ok = stake <= low.ceilingSats;
  return { ok, ceilingSats: low.ceilingSats, why: ok ? `within the census's ceiling: ${low.why}` : `a ${stake} sat stake is over what this census supports - ${low.why}` };
}

/**
 * A ROUND'S GROSS CEILING (§0A.7b RULED 2026-11-07, kanban #1293/#1329): max_round_pool of its census - the ceiling's bracket times the players a round
 * holds - in sat, or null on a test network (it shows the ceiling and refuses nothing, ruling A) or for a free round. A market round's filled volume
 * plus an order may not pass it: "Before this a book round could hold a thousand 100,000-sat orders under a committee bonded for a 1,000-sat bracket."
 */
export function maxRoundPoolSats({ entries, stakeSats, networkId = null, maxPlayers = MAX_PLAYERS_PER_ROUND, incomeSats = null }) {
  if (networkId && isTestNetwork(networkId)) return null;
  if (BigInt(stakeSats) === 0n) return null;
  const c = stakeWithinCeiling({ entries, stakeSats, maxPlayers, incomeSats });
  return c.ceilingSats * BigInt(maxPlayers);
}
/**
 * AN ATTESTED ROUND'S GROSS AGAINST ITS ATTESTORS (§0A.7a RULED 2026-11-07, kanban #1292/#1328): gross <= Σ attestor_bond / 4, as §5A.10 caps a game
 * round against its committee - what one attestor who signs both sides could take is bounded by what the contradiction proof slashes. `bondsSats` each
 * attestor's bond (drawn attestors: their census bonds). null on a test network, as max_round_pool (#1329): shown, nothing refused.
 */
export function attestedGrossCapSats({ bondsSats, networkId = null }) {
  if (networkId && isTestNetwork(networkId)) return null;
  return (bondsSats || []).reduce((t, b) => t + BigInt(b || 0n), 0n) / 4n;
}
/** The smaller of two caps, null meaning none. */
export const minCap = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : (BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b)));
/** May an order of `orderSats` join a round whose filled volume is `filledSats` under a pool of `poolSats` (null: no ceiling)? */
export const orderWithinPool = ({ filledSats, orderSats, poolSats }) => poolSats === null || poolSats === undefined || BigInt(filledSats) + BigInt(orderSats) <= BigInt(poolSats);
