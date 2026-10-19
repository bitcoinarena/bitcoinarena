// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ONE PARSE OF A LAUNCHER'S LIGHTNING SETTINGS. main-settings.test.js
// pins what src/main.js does with the answer; this pins the answer itself, so a
// second launcher reading it cannot accept what the first refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningFromEnv, LND_SETTINGS } from '../src/node-start.js';

const all = { ARENA_LNCLI: '/x/lncli', ARENA_LND_DIR: '/x/lnd', ARENA_LND_RPC: '127.0.0.1:1' };

test('no settings is a daemon with no Lightning, and says so', () => {
  assert.deepEqual(lightningFromEnv({}), { ok: true, given: false });
});

test('each of the four missing alone is refused, naming it', () => {
  const full = { ...all, ARENA_LND_NETWORK: 'regtest' };
  for (const k of LND_SETTINGS) {
    const env = { ...full }; delete env[k];
    const got = lightningFromEnv(env);
    assert.equal(got.ok, false, k);
    assert.match(got.why, new RegExp(`missing: ${k}`));
  }
});

test('mainnet, or a network spelled wrong, is refused', () => {
  for (const net of ['mainnet', 'testnet', 'Testnet4']) {
    const got = lightningFromEnv({ ...all, ARENA_LND_NETWORK: net });
    assert.equal(got.ok, false, net);
    assert.match(got.why, /is not a network a round may run on/);
  }
});

test('regtest and testnet4 each get an invoice reader, and nothing that holds a stake', () => {
  // A LAUNCHER'S LIGHTNING IS AN INVOICE READER NOW (§23.6, RULED 2026-09-22 22:59). This test used to
  // assert that each network also got a PREFLIGHT - "can this lnd hold a round's stakes" - and a port
  // with `look` and `settle` on it. Both were THRESHOLD_LN's hold invoice. So were the gateway tests that
  // followed here: the gateways a launcher named fed only that preflight.
  for (const net of ['regtest', 'testnet4']) {
    const got = lightningFromEnv({ ...all, ARENA_LND_NETWORK: net });
    assert.equal(got.ok, true, net);
    assert.equal(typeof got.lightning.decode, 'function');
    assert.equal(got.preflight, undefined, `${net} still hands out a Lightning preflight`);
    assert.equal(got.lightning.settle, undefined, `${net}'s port can still settle a hold`);
  }
});
