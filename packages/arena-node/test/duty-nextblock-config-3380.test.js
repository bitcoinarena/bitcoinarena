// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEXT BLOCK DAY NAMES A CONFIG ITS CORE RUNS (kanban #3380): from 2026-11-21 every Next Block day on testnet named config 00..00 - the
// built-in template's, taken once no day of the app was held any more, and copied by every later day - and every seat refused the series
// ("runs btc-logistics truck (7d197042) but not the config 0000000000000000 that round names"), so no seat listed a Next Block round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { dutyFieldsOf } from '../src/duty-guard.js';
import { dayConfigOf, DUTY_TEMPLATE } from '../src/duty-poster.js';

const id = (n) => toHex(new Uint8Array(32).fill(n));
const core = (h, configs) => ({ hash: fromHex(id(h)), configs: configs.map((c) => fromHex(id(c))) });
const v8 = { id: id(8), name: 'nextblock', version: 8, manifest: { gameName: 'nextblock', version: 8, cores: [core(0x7d, [0x21, 0xf5])] } };

test('the nextblock fields carry the picked core\'s configs', () => {
  const f = dutyFieldsOf('nextblock', v8, { fromHex });
  assert.equal(f.ok, true);
  assert.deepEqual(f.configs, [id(0x21), id(0xf5)]);
});

test('a day whose template names no config of its core (the built-in zero) names the core\'s first config', () => {
  const got = dayConfigOf({ fieldsConfig: undefined, templateConfig: DUTY_TEMPLATE.configHash, coreConfigs: [id(0x21), id(0xf5)] });
  assert.equal(toHex(got), id(0x21));
});

test('a template config the core runs is kept, a field config wins, and no core list keeps the template as before', () => {
  assert.equal(toHex(dayConfigOf({ templateConfig: fromHex(id(0xf5)), coreConfigs: [id(0x21), id(0xf5)] })), id(0xf5));
  assert.equal(toHex(dayConfigOf({ fieldsConfig: fromHex(id(0x0d)), templateConfig: fromHex(id(0xf5)), coreConfigs: [id(0x21)] })), id(0x0d));
  assert.equal(toHex(dayConfigOf({ templateConfig: fromHex(id(0x33)), coreConfigs: null })), id(0x33));
});

test('configRunByCore: a template whose core does not run its config is refused by name; a market or an unknown core is not judged', async () => {
  const { configRunByCore } = await import('../src/duty-guard.js');
  const cat = new Map([[id(8), { id: id(8), name: 'nextblock', version: 8, manifest: v8.manifest }]]);
  const t = (cfg, coreH = 0x7d, g = 8) => ({ gameId: fromHex(id(g)), simCoreHash: fromHex(id(coreH)), configHash: fromHex(id(cfg)) });
  assert.deepEqual(configRunByCore(t(0x21), cat), { ok: true, known: true });
  const zero = configRunByCore({ ...t(0x21), configHash: new Uint8Array(32) }, cat);
  assert.equal(zero.ok, false);
  assert.match(zero.why, /runs config 21212121, f5f5f5f5, not 0000000000000000/);
  assert.equal(configRunByCore({ ...t(0x21), simCoreHash: new Uint8Array(32) }, cat).known, false);
  assert.equal(configRunByCore(t(0x21, 0x99), cat).known, false);
  assert.equal(configRunByCore(t(0x21, 0x7d, 9), cat).known, false);
});

// 2026-11-23 03:09Z: the 4th grid at config 2170f250 was still refused by every seat - "min_score 0 is below game nextblock's 1" - because the
// template it was built from was the built-in one (min_score 0, protocol 3) the refused days had copied; the 11-18 day (min_score 100000,
// protocol 13) was still held
test('a day carries the newest held template its manifest takes, not a newer refused one; the fit is the seats\' own check', async () => {
  const { dayTemplate } = await import('../src/duty-poster.js');
  const { templateFitsManifest } = await import('../src/duty-guard.js');
  const { roundFitsManifest } = await import('../../arena-protocol/src/manifest.js');
  const { NETWORK_ID_TESTNET4 } = await import('../../arena-protocol/src/genesis-ids.js');
  const g = fromHex(id(8));
  const good = { seriesGrid: true, networkId: NETWORK_ID_TESTNET4, gameId: g, startTimeMs: 1n, minScore: 100000, protocolVersion: 13, configHash: fromHex(id(0x21)) };
  const bad = { ...good, startTimeMs: 9n, minScore: 0, protocolVersion: 3, configHash: new Uint8Array(32) };
  const fits = (t) => t.minScore >= 1 && t.configHash[0] === 0x21;
  const t = dayTemplate({ held: [good, bad], family: new Set([id(8)]), networkId: NETWORK_ID_TESTNET4, game: 'nextblock', fits });
  assert.equal(t.from, 'held');
  assert.equal(t.contract.minScore, 100000);
  assert.equal(t.contract.protocolVersion, 13);
  assert.equal(dayTemplate({ held: [good, bad], family: new Set([id(8)]), networkId: NETWORK_ID_TESTNET4, game: 'nextblock' }).contract.minScore, 0, 'without the check: the newest, as before');
  // the seats' check through the catalog: a manifest whose min_score is 1 refuses a round at 0, by name
  const cat = new Map([[id(8), { name: 'nextblock', version: 8, manifest: { gameName: 'nextblock' } }]]);
  const r = templateFitsManifest(bad, cat, (c) => (c.minScore >= 1 ? { ok: true } : { ok: false, why: 'that round\'s min_score 0 is below game "nextblock"\'s 1' }));
  assert.equal(r.ok, false); assert.match(r.why, /min_score 0 is below/);
  assert.equal(templateFitsManifest(good, cat, (c) => (c.minScore >= 1 ? { ok: true } : { ok: false })).ok, true);
  assert.equal(templateFitsManifest(bad, new Map(), roundFitsManifest).known, false, 'a game the catalog does not hold is not judged');
});

test('with no held day its manifest takes, a Next Block day starts at min_score 1 point (SCORE_SCALE), not the built-in 0', async () => {
  const { dayTemplate } = await import('../src/duty-poster.js');
  const { SCORE_SCALE } = await import('../../arena-protocol/src/constants.js');
  const t = dayTemplate({ held: [], family: new Set(), networkId: new Uint8Array(32), game: 'nextblock' });
  assert.equal(t.from, 'built-in');
  assert.equal(t.contract.minScore, SCORE_SCALE);
  assert.equal(dayTemplate({ held: [], family: new Set(), networkId: new Uint8Array(32), game: 'updown' }).contract.minScore, 0, 'a market keeps 0');
});
