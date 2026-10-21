// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT NEXTBLOCK SHARES WITH THE ENGINE IT RUNS ON, HELD BY THE GAME (the engine imports no game, so the
// checks that were imports are tests on the game's side). The engine's sha256 and the core's give the same digests; the
// core runs at the tick rate the engine states; nextblock's founding config still hashes to the GENESIS_CONFIG_HASH the
// network's genesis parameters name; and the round fields only nextblock reads are judged by nextblock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256bytes as engineSha, sha256hex as engineHex } from 'arena-sdk/sha256';
import { sha256bytes as coreSha, sha256hex as coreHex } from '../src/sha256.js';
import * as engineTick from 'arena-sdk/tick';
import * as coreTick from '../src/tick.js';
import { GENESIS_CONFIG_HASH } from 'arena-sdk/genesis-ids';
import { genesisFor } from 'arena-sdk/genesis';
import { computeGenesisConfigHash } from '../config/game-config.js';
import { contractWarnings } from 'arena-sdk/contracts';
import { NEXTBLOCK, nextblockRoundWarnings } from '../plugin/nextblock.js';
import { hostedPlugins } from 'arena-sdk/host';
import { toHex } from 'arena-sdk/hash';

test('the engine\'s sha256 and the core\'s give the same digests, and both are SHA-256', () => {
  const inputs = [new Uint8Array(0), new TextEncoder().encode('abc'), new Uint8Array(55).fill(7), new Uint8Array(56).fill(9),
    new Uint8Array(64).fill(1), Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) & 255)];
  for (const b of inputs) {
    const want = createHash('sha256').update(b).digest('hex');
    assert.equal(toHex(engineSha(b)), want, `engine, ${b.length} bytes`);
    assert.equal(toHex(coreSha(b)), want, `core, ${b.length} bytes`);
    assert.equal(engineHex(b), coreHex(b));
  }
});

test('the core runs at the tick rate the engine states', () => {
  assert.equal(coreTick.TICK_DT, engineTick.TICK_DT);
  assert.equal(coreTick.TICKS_PER_SECOND_NUM, engineTick.TICKS_PER_SECOND_NUM);
  assert.equal(coreTick.TICKS_PER_SECOND_DEN, engineTick.TICKS_PER_SECOND_DEN);
});

test('nextblock\'s founding config still hashes to the GENESIS_CONFIG_HASH the network names', () => {
  assert.equal(toHex(computeGenesisConfigHash()), toHex(GENESIS_CONFIG_HASH));
  for (const net of ['regtest', 'testnet4']) assert.equal(toHex(genesisFor(net).genesisConfigHash), toHex(GENESIS_CONFIG_HASH), net);
});

test('the truck fields of a round are judged by nextblock, and the engine appends its judgement only when handed it', () => {
  const c = { rankNumerator: 3, rankDenominator: 4, minScore: 1, exposureReference: 0, timeFloor: 150, timeCeil: 30 };
  assert.deepEqual(nextblockRoundWarnings(c), ['exposure_ignored', 'time_factor_degenerate']);
  assert.deepEqual(contractWarnings(c), [], 'the engine judged a field only the game reads');
  const hosted = hostedPlugins([NEXTBLOCK]).get(toHex(NEXTBLOCK.gameId));
  assert.deepEqual(contractWarnings(c, hosted.roundWarnings), ['exposure_ignored', 'time_factor_degenerate']);
  assert.deepEqual(contractWarnings({ ...c, exposureReference: 1000, timeFloor: 30, timeCeil: 150 }, hosted.roundWarnings), []);
});
