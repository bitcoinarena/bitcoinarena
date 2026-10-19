// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REGISTRATION RUNS NO CORE (spec §0A.6): truck-cores.js writes out what it would otherwise have to run a
// core to know - the config hashes (config/game-config.js computes them from the cores' rule files), the truck's name and
// its longest run - so a node importing nextblock's registration evaluates no core module in its own thread. Here, where
// running the cores natively is fine, each written value is computed again and compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCurrentConfigHash, computeDe2fConfigHash, computeConfigV3Hash } from '../config/game-config.js';
import { CORE as NOW } from '../src/adapter.js';
import { CORE as F2069 } from '../frozen/2069b4c2/adapter.js';
import { CORE as F7E21 } from '../frozen/7e2123d1/adapter.js';
import { CORE as FDE2F } from '../frozen/de2f263d/adapter.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TRUCK_CURRENT_CONFIG, TRUCK_V3_CONFIG, TRUCK_DE2F_CONFIG, TRUCK_NAME, TRUCK_RUN_TICKS, TRUCK, TRUCK_2069, TRUCK_7E21,
  TRUCK_DE2F, TRUCK_BEFORE_FORK, NEXTBLOCK_CORES, NEXTBLOCK_CORES_V3, TRUCK_F0CC } from '../plugin/truck-cores.js';

test('the written config hashes are the computed ones', () => {
  assert.equal(TRUCK_CURRENT_CONFIG, toHex(computeCurrentConfigHash()));
  assert.equal(TRUCK_V3_CONFIG, toHex(computeConfigV3Hash()));
  assert.equal(TRUCK_DE2F_CONFIG, toHex(computeDe2fConfigHash()));
});

test('the written name and run length are every core\'s own', () => {
  for (const c of [NOW, F2069, F7E21, FDE2F]) { assert.equal(c.name, TRUCK_NAME); assert.equal(c.RUN_TICKS, TRUCK_RUN_TICKS); }
  assert.equal(TRUCK_BEFORE_FORK.fixedRunTicks, F2069.RUN_TICKS);
});

test('each core carries the files the sandbox loads, and a native adapter only when asked, never as a copied field', () => {
  for (const [c, a] of [[TRUCK, NOW], [TRUCK_2069, F2069], [TRUCK_7E21, F7E21], [TRUCK_DE2F, FDE2F], [TRUCK_BEFORE_FORK, F2069]]) {
    assert.ok(c.root && c.url.startsWith(c.root), c.name);
    assert.equal(Object.keys(c).includes('adapter'), false, `${c.name} copies its adapter with every spread`);
    assert.equal(c.adapter, a);
  }
  assert.equal(TRUCK_BEFORE_FORK.sourceHash, TRUCK_2069.hash);
  assert.equal(NEXTBLOCK_CORES.size, 5);
  assert.equal(NEXTBLOCK_CORES_V3.size, 6, 'version 3: the five and the truck that knows the larger truck');
  assert.equal(NEXTBLOCK_CORES_V3.get(TRUCK_F0CC.hash), TRUCK_F0CC);
  assert.ok(TRUCK_F0CC.root && TRUCK_F0CC.url.startsWith(TRUCK_F0CC.root));
});

test('importing the registration evaluates no core module', async () => {
  const { execFileSync } = await import('node:child_process');
  // a fresh process: the module hooks list every module it loads, and none may be a file of a core
  const hook = `import { registerHooks } from 'node:module'; const seen = [];
    registerHooks({ load(url, ctx, next) { seen.push(url); return next(url, ctx); } });
    await import(${JSON.stringify(new URL('../plugin/nextblock.js', import.meta.url).href)});
    console.log(JSON.stringify(seen.filter((u) => /\\/nextblock\\/(src|frozen)\\//.test(u))));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', hook], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), []);
});
