// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HELLO WORLD AS AN EXTERNAL APP (kanban #568): its registration loads with nothing but arena-sdk, its manifest decodes and its id is
// the one the network knows - in the Arena's own tree and in its own repository alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME, HELLO_WORLD_GAME_ID } from '../plugin/hello-world.js';
import { decodeManifest, gameIdOf } from 'arena-sdk/manifest';
import { toHex } from 'arena-sdk/hash';

test('the registration: its signed manifest, its id, its info', () => {
  assert.equal(toHex(GAME.gameId), '32ee1aa45e485eb2bc6b35d118a79f9724ab8019a0ceeb71eda45a84200c130f');
  assert.equal(toHex(HELLO_WORLD_GAME_ID), toHex(GAME.gameId));
  assert.equal(GAME.name, 'hello-world');
  assert.ok(GAME.info, 'its signed description');
  void decodeManifest; void gameIdOf;
});
