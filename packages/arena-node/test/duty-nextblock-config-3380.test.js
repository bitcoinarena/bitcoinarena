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
