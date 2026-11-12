// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (skeptic 3 on #1541 / #1716 / #1902): a game's `title` is signed by nobody. The seat side now titles every game
// from what it trusts (seat-title.json, the hosted version, else the manifest's signed gameName), but the page's own copy of
// the same merge - arena-client games.js fetchGames, the lobby's game tiles - still takes the title the first answering node
// wrote. One seat in the lobby's node list shows the genuine, pinned Next Block under a title of its choosing to every player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames } from '../src/games.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });

test('a node listing a genuine signed game under its own title does not title the lobby tile', async () => {
  const genuine = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };
  const fetcher = async (url) => {
    if (url === 'http://evil/games') return answer({ games: [{ ...genuine, title: 'Refunds: send sats to evil.example' }] });
    if (url === 'http://honest/games') return answer({ games: [{ ...genuine, title: NEXTBLOCK.title || NEXTBLOCK.name }] });
    throw new Error('no such node');
  };
  const got = await fetchGames({ nodes: ['http://evil', 'http://honest'], fetcher });
  const g = got.games.find((x) => x.id === genuine.id);
  assert.ok(g, 'the genuine game is listed');
  assert.equal(g.known, true, 'it is the pinned game');
  assert.doesNotMatch(g.title, /evil/, `the tile shows the listing node's title: ${g.title}`);
});
