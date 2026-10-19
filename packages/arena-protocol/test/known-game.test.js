// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE KNOWN-GOOD LIST HOLDS THE GAME THIS TREE BUILDS, WITH THE CORE AND CONFIG IT BUILDS (§5, §0A.6).
//
// The list is generated from each game's signed manifest (`node packages/arena-protocol/tools/known-games.js`), and this
// recomputes the core hash from the sources: a change to the core turns this red until a new nextblock manifest lists
// it (its developer, with the dev client: nextblock/tools/sign-manifest.mjs) and the list is regenerated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, toHex } from '../src/hash.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { gameIsKnownGood } from '../src/known-game.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { computeCurrentConfigHash, computeGenesisConfigHash, computeDe2fConfigHash } from '../../nextblock/config/game-config.js';

test('nextblock is on the known-good list with the core this tree builds under its current config, and is accepted', () => {
  const now = coreHashHex();
  const game = KNOWN_GOOD_GAMES[toHex(NEXTBLOCK_GAME_ID)];
  assert.ok(game, 'nextblock\'s manifest is not listed: run node packages/arena-protocol/tools/known-games.js');
  assert.equal(game.name, 'nextblock');
  assert.ok(game.cores[now], `core ${now} is not listed for nextblock: sign a new manifest and regenerate the list`);
  assert.deepEqual(gameIsKnownGood(NEXTBLOCK_GAME_ID, fromHex(now), computeCurrentConfigHash()), { ok: true, game: 'nextblock' });
  assert.ok(Object.isFrozen(KNOWN_GOOD_GAMES));
});

test('an unknown game, a core its game does not list, or no game or core at all is refused by name', () => {
  const now = fromHex(coreHashHex());
  assert.match(gameIsKnownGood(new Uint8Array(32).fill(1), now, computeCurrentConfigHash()).why, /not on this client's known-good list of games/);
  assert.match(gameIsKnownGood(undefined, now, computeCurrentConfigHash()).why, /names no 32-byte game/);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, new Uint8Array(32).fill(1), computeCurrentConfigHash()).why, /nextblock's manifest does not list/);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, undefined).why, /names no 32-byte core hash/);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, new Uint8Array(31)).why, /names no 32-byte core hash/);
});

// AND THE CONFIG (2026-10-04, fix 1 of the spec audit; §27A.6): a listed core plays the configs its game lists for it.
test('a round on a listed core is refused under a config its game does not list for that core, and accepted under its own', () => {
  const DE2F = fromHex('de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8');
  const OLD = fromHex('2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e');
  const ok = { ok: true, game: 'nextblock' };
  assert.deepEqual(gameIsKnownGood(NEXTBLOCK_GAME_ID, DE2F, computeDe2fConfigHash()), ok);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, DE2F, computeCurrentConfigHash()).why, /not a config nextblock lists for that core/);
  assert.deepEqual(gameIsKnownGood(NEXTBLOCK_GAME_ID, DE2F, computeGenesisConfigHash()), ok, 'the free rounds made before its config had a hash');
  assert.deepEqual(gameIsKnownGood(NEXTBLOCK_GAME_ID, OLD, computeGenesisConfigHash()), ok);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, OLD, computeCurrentConfigHash()).why, /not a config nextblock lists for that core/);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, DE2F, new Uint8Array(32).fill(7)).why, /not a config nextblock lists for that core/);
  assert.match(gameIsKnownGood(NEXTBLOCK_GAME_ID, DE2F, new Uint8Array(3)).why, /names no 32-byte config hash/);
});
