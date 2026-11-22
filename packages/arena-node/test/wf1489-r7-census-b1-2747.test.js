// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2747, wf1489 r7 census b1: A PASSED CONFIG PROPOSAL IS ROUTED AROUND BY NAMING THE TRUCK'S OTHER INSTALLED CONFIG.
//
// The ballot (§27A.7.5) governs which config a round may be served under: POST /round runs configRefusal ->
// ballot-chain.js configServesRound over the passed proposals' history, whose first entry is the ballot genesis 2170f250 -
// the config the truck core plays. But configServesRound answers { ok: true, governed: false } for every config the
// history never named, and the truck core (nextblock truck-cores.js TRUCK, and every truck core after it) is installed
// with TWO configs: 2170f250 and the older per-player v3, f51759b6, which the ballot never names. coreOfGame (plugins.js)
// takes either. So once the network votes 2170f250 -> X, a round creator (a stranger who funds a round, or one seat's
// operator writing a series) names f51759b6 at a census height after the activation: the ballot calls it "not governed",
// the core door runs it, and the round is served under rules the network voted away - for good, with no lookback limit.
// The safe behaviour: once the ballot has moved the network off a config, a round created after that activation on the
// same core is served only under the config live at its height - a sibling config of the governed core is governed too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configServesRound, liveConfig, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { coreOfGame } from '../src/plugins.js';
import { TRUCK, TRUCK_CURRENT_CONFIG, TRUCK_V3_CONFIG } from '../../nextblock/plugin/truck-cores.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('after the ballot activates a new config, a round on the same core cannot be served under its other, ungoverned config', () => {
  // the truck core plays the ballot's genesis config and v3 beside it
  assert.equal(toHex(BALLOT_GENESIS.configHash), TRUCK_CURRENT_CONFIG);
  assert.ok(TRUCK.configs.has(TRUCK_V3_CONFIG), 'the truck core is installed with v3 too');
  const plugin = { cores: new Map([[TRUCK.hash, TRUCK]]) };
  // the network votes 2170f250 -> X, active from height 1000
  const X = fromHex('ab'.repeat(32));
  const passed = [{ id: fromHex('01'.repeat(32)), parent: BALLOT_GENESIS.configHash, configHash: X, config: Uint8Array.of(9), activationHeight: 1000 }];
  const history = liveConfig({ genesis: BALLOT_GENESIS, passed, height: 10 ** 9 }).history;
  // the voted-out config is refused for a round created after the activation (works today)
  assert.equal(configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 2000, history }).ok, false);
  // the attacker's round: same truck core, census height 2000 (after the activation), naming v3
  const contract = { simCoreHash: fromHex(TRUCK.hash), configHash: fromHex(TRUCK_V3_CONFIG), blockTicks: 90, committeeTimeMs: 1n };
  const core = coreOfGame(contract, plugin);
  assert.equal(core.ok, true, 'the core door runs v3 on the truck');
  // the seat knows the round's core, and so the configs installed with it (server.js configRefusal passes them)
  const siblings = [...core.core.configs.keys()];
  const served = configServesRound({ configHash: contract.configHash, height: 2000, history, siblings });
  // SAFE: not served - the config live at 2000 for this core is X
  assert.equal(served.ok && core.ok, false,
    `a round created at 2000, after the ballot made ${toHex(X).slice(0, 16)} live, is served under v3 ${TRUCK_V3_CONFIG.slice(0, 16)} (governed: ${served.governed})`);
  assert.equal(served.governed, true);
  assert.equal(toHex(served.live), toHex(X), 'the refusal names the config live at 2000');
  // the honest paths stay: v3 before the activation, v3 while no proposal passed, and X itself after the activation
  assert.equal(configServesRound({ configHash: contract.configHash, height: 999, history, siblings }).ok, true, 'v3 for a round created before the activation');
  const genesisOnly = liveConfig({ genesis: BALLOT_GENESIS, passed: [], height: 10 ** 9 }).history;
  assert.deepEqual(configServesRound({ configHash: contract.configHash, height: 2000, history: genesisOnly, siblings }), { ok: true, governed: false });
  assert.equal(configServesRound({ configHash: X, height: 2000, history, siblings }).ok, true);
  // a config of another core (not a sibling) stays outside the ballot
  assert.deepEqual(configServesRound({ configHash: fromHex('cd'.repeat(32)), height: 2000, history, siblings: ['ef'.repeat(32)] }), { ok: true, governed: false });
});
