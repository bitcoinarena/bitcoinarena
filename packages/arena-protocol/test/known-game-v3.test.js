// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NEXTBLOCK VERSION 3 IS A GAME THIS CLIENT KNOWS (the live break of 2026-10-16 05:19Z): once the seats listed v3's
// rounds the page chose v3, did not find it among the known-good games, and took Tick Tock for a game with its own HTML client -
// "Tick Tock, Next Block cannot be loaded: games/nextblock/index.html hashes to ..., which nextblock's manifest does not name";
// and an entry for a v3 round named a world secret, which the seats refused ("this round shares one world among its players").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { sharedWorldOf, gameDonationSetIdOf } from '../src/known-game.js';
import { fromHex } from '../src/hash.js';
import { MANIFEST_V3, GAME_ID_V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { toHex } from '../src/hash.js';

const V3 = 'b8b88e233baac6671c8ac6da8193f816d7f552423a3888b184018b7b49839651';

test('v3 is known: nextblock, its every core and config as its signed manifest lists them, one shared world, protocol 10', () => {
  assert.equal(toHex(GAME_ID_V3), V3);
  const k = KNOWN_GOOD_GAMES[V3];
  assert.ok(k, 'v3 is listed');
  assert.equal(k.name, 'nextblock');
  assert.equal(k.requiredProtocolVersion, 10);
  assert.deepEqual(Object.keys(k.cores).sort(), MANIFEST_V3.cores.map((c) => toHex(c.hash)).sort());
  for (const c of MANIFEST_V3.cores) assert.deepEqual([...k.cores[toHex(c.hash)]], c.configs.map(toHex), `core ${toHex(c.hash).slice(0, 8)}`);
  assert.ok(k.cores['f0cc7b7b2e75e350149ff8a6e58a1cc861a3ab4969d1c81b2206564b57ffb7a8'], 'the truck that knows the larger truck');
  assert.deepEqual(sharedWorldOf(fromHex(V3)), ['2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d'], 'one world per round, as v1');
  assert.equal(gameDonationSetIdOf(fromHex(V3)), toHex(MANIFEST_V3.gameDonationSetId));
});

test('the hand-kept fields of the other games stay (the generator would drop them)', () => {
  assert.ok(Object.values(KNOWN_GOOD_GAMES).some((g) => g.seatsPerTable === true), 'RPS v2 keeps seatsPerTable');
});
