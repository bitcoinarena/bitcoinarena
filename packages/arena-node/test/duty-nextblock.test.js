// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TICK TOCK VERSION A DAILY DUTY POSTS (kanban #523): DUTY_NEXTBLOCK_PLUGIN + DUTY_NEXTBLOCK_CORE give the round's game id and core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { nextblockDutyFields, loadNextblockPlugin } from '../tools/duty-nextblock.mjs';
import { TRUCK_F0CC_HASH, TRUCK_0847_HASH } from '../../nextblock/plugin/truck-cores.js';

test('version 5 on its larger truck 0847c99f: the game id of the registration, the core named by prefix', async () => {
  const v5 = await loadNextblockPlugin('nextblock-v5.js');
  assert.equal(toHex(v5.gameId), '09bfe97a6a2b640b69ee9f4a175d25e091ee7229e536f1f3e1adc431f60afb1b');
  const r = nextblockDutyFields(v5, '0847c99f');
  assert.equal(r.ok, true, r.why);
  assert.equal(toHex(r.fields.simCoreHash), TRUCK_0847_HASH);
  assert.deepEqual(r.fields.gameId, v5.gameId);
});

test('a registration with two cores needs one named; a core it does not install is refused', async () => {
  const v5 = await loadNextblockPlugin('nextblock-v5.js');
  assert.match(nextblockDutyFields(v5).why, /installs 2 cores \(.*\): name one in DUTY_NEXTBLOCK_CORE/);
  assert.match(nextblockDutyFields(v5, TRUCK_F0CC_HASH.slice(0, 8)).why, /core f0cc7b7b is none of/);
  assert.match(nextblockDutyFields({}).why, /not a registration/);
});

test('version 3 on f0cc7b7b reads as DUTY_NEXTBLOCK_V3=1 did; a file that is no nextblock plugin is refused', async () => {
  const v3 = await loadNextblockPlugin('nextblock-v3.js');
  const r = nextblockDutyFields(v3, 'f0cc7b7b');
  assert.equal(r.ok, true, r.why);
  assert.equal(toHex(r.fields.simCoreHash), TRUCK_F0CC_HASH);
  await assert.rejects(() => loadNextblockPlugin('../../evil.js'), /names a nextblock plugin file/);
});
