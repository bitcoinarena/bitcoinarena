// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3897 (2.0 release blocker, found by the #3896 devnet run): 2.0 speaks protocols 34, 35 and 36, each with the gate its card defines -
// on the round's own version, so a round below it keeps today's rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_PROTOCOL_VERSIONS, speaksVersion, GENESIS_RUN_VERSION, decidesGenesisRun, POOL_FIRST_VERSION, poolsFirst,
  DISJOINT_RULES_VERSION, runsDisjointRules } from '../src/constants.js';
import { SIGNED_DRAW_VERSION } from '../src/sortition.js';
import { IDENTITY_BOUND_VERSION, bindsIdentity } from '../src/identity-proof.js';
import { NAMED_CLAIM_VERSION } from '../src/arena-lock.js';

test('#3897: 2.0 speaks 33, 34, 35 and 36 (the rollout plan of the 2.0 release)', () => {
  for (const v of [NAMED_CLAIM_VERSION, DISJOINT_RULES_VERSION, 34, 35, 36]) assert.equal(speaksVersion(v), true, `protocol ${v} spoken`);
  assert.equal(speaksVersion(32), false, '32 stays prepared, not spoken (#2832)');
  // 37 joined with the rulings of 2026-11-28 (kanban #3824, #3882, ...): spoken, written by round creators only with its rollout
  assert.equal(speaksVersion(37), true);
  assert.equal(speaksVersion(38), false);
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort((a, b) => a - b).slice(-5), [33, 34, 35, 36, 37]);
});

test('#3897: each version gates on the round\'s own version (#3743 #3762 #3800 at 34, #3854 at 35)', () => {
  assert.equal(SIGNED_DRAW_VERSION, 34); assert.equal(GENESIS_RUN_VERSION, 34); assert.equal(IDENTITY_BOUND_VERSION, 34); assert.equal(POOL_FIRST_VERSION, 35);
  for (const v of [31, 33]) { assert.equal(decidesGenesisRun(v), false); assert.equal(bindsIdentity(v), false); assert.equal(poolsFirst(v), false); }
  for (const v of [34, 35, 36]) { assert.equal(decidesGenesisRun(v), true); assert.equal(bindsIdentity(v), true); assert.equal(runsDisjointRules(v), true); }
  assert.equal(poolsFirst(34), false); assert.equal(poolsFirst(35), true); assert.equal(poolsFirst(36), true);
});
