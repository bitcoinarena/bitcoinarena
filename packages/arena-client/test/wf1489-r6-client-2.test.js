// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r6: ONE SEAT'S UNSIGNED MANIFEST TAKES A GAME'S TILE. fetchGames keeps any manifest that hashes to the id the seat named -
// it never asks whether the game's developer signed it (manifest.js manifestStands) - and oneTilePerGame groups versions by
// "developer key:name" and shows the highest `version`. So one seat lists a copy of nextblock's manifest with version + 1 and a zero
// signature: the page's tile (and every link naming the game by name, and every old-version link with no live round) opens a game
// id no honest seat hosts and no round runs under - the game is gone from every player's lobby on one seat's word.
// Safe: a manifest its developer did not sign is not kept, and the tile is the signed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames, oneTilePerGame } from '../src/games.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });

test('a manifest copy under the same developer key with a higher version and no valid signature does not take the tile', async () => {
  const real = NEXTBLOCK.manifest;
  const forged = { ...real, version: (real.version || 0) + 1, signature: new Uint8Array(real.signature.length) };
  const forgedId = toHex(gameIdOf(forged));
  const listed = (m, name) => ({ id: toHex(gameIdOf(m)), name, title: name, icon: null, manifest: toHex(encodeManifest(m)) });
  const fetcher = async (url) => {
    if (url.startsWith('http://honest')) return answer({ games: [listed(real, 'nextblock')] });
    if (url === 'http://liar/games') return answer({ games: [listed(forged, 'nextblock')] });
    throw new Error('no such node');
  };
  const got = await fetchGames({ nodes: ['http://honest1', 'http://honest2', 'http://honest3', 'http://liar'], fetcher });
  const tile = oneTilePerGame(got.games).find((t) => t.name === 'nextblock');
  assert.ok(tile, 'nextblock has a tile');
  assert.notEqual(tile.id, forgedId, `the nextblock tile is ${tile.id.slice(0, 16)}: the liar's unsigned copy (version ${forged.version}, hosted by ${tile.nodes.join(', ')}), not the signed ${toHex(NEXTBLOCK.gameId).slice(0, 16)} the other three seats host`);
});
