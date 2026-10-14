// THE STAKE CEILING FROM CENSUS HEALTH (§5A.10, kanban #306): nodes and bonded capital per role against the gross pool (stake x 64
// players); under 10 nodes play money only; the lower role binds; a free round has no ceiling; test networks are told apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleCeiling, stakeWithinCeiling, isTestNetwork, MAX_PLAYERS_PER_ROUND } from '../src/census-health.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';

test('the ceiling by the table: nodes and capital per role, the gross pool at 64 players', () => {
  assert.equal(MAX_PLAYERS_PER_ROUND, 64n);
  assert.equal(roleCeiling({ nodes: 9, bondedSats: 10n ** 12n, stakeSats: 100n }).ceilingSats, 0n, 'under 10 nodes: play money only');
  // 10 nodes and 20 x (10 sat x 64) = 12,800 sat bonded: 10 sat
  assert.equal(roleCeiling({ nodes: 10, bondedSats: 12800n, stakeSats: 100n }).ceilingSats, 10n);
  assert.equal(roleCeiling({ nodes: 10, bondedSats: 12799n, stakeSats: 100n }).ceilingSats, 0n);
  // 25 nodes and 100 x (1,000 sat x 64) = 6,400,000 sat: 1,000 sat
  assert.equal(roleCeiling({ nodes: 25, bondedSats: 6400000n, stakeSats: 100n }).ceilingSats, 1000n);
  // 50 nodes and 200 x the round's own gross pool: the contract's stake
  const c = roleCeiling({ nodes: 50, bondedSats: 200n * 5000n * 64n, stakeSats: 5000n });
  assert.equal(c.ceilingSats, 5000n); assert.equal(c.contractDefined, true);
});

test('a round is within its census\'s ceiling only when both roles support its stake; a free round always is', () => {
  const node = (roles, bondSats) => ({ roles, bondSats });
  const both = Array.from({ length: 15 }, () => node(['game', 'settlement'], 1000000n));      // 15 nodes, 15,000,000 sat per role
  assert.equal(stakeWithinCeiling({ entries: both, stakeSats: 100n }).ok, true);
  assert.equal(stakeWithinCeiling({ entries: both, stakeSats: 1000n }).ok, false);
  const fewSettlers = [...Array.from({ length: 30 }, () => node(['game'], 10000000n)), ...Array.from({ length: 9 }, () => node(['settlement'], 10000000n))];
  const r = stakeWithinCeiling({ entries: fewSettlers, stakeSats: 10n });
  assert.equal(r.ok, false); assert.match(r.why, /9 eligible nodes, under 10: play money only/);
  assert.equal(stakeWithinCeiling({ entries: [], stakeSats: 0n }).ok, true);
  assert.equal(isTestNetwork(NETWORK_ID_REGTEST), true); assert.equal(isTestNetwork(NETWORK_ID_TESTNET4), true);
  assert.equal(isTestNetwork(new Uint8Array(32).fill(9)), false);
});
