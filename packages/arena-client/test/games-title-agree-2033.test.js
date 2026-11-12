// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2033 (after #1716, #1902, #1541, #1489): the lobby's tile title and icon stand only when more than half of the addresses
// that answered name them byte-identical; otherwise the manifest's signed gameName and no icon. One node cannot title a game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames } from '../src/games.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });
const genuine = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };
const EVIL = 'Refunds: send sats to evil.example';
const lobby = (lists) => async (url) => {
  const n = url.replace(/\/games$/, '');
  if (n in lists) return answer(lists[n]);
  throw new Error('no such node');
};
const tile = async (lists, nodes = Object.keys(lists)) => (await fetchGames({ nodes, fetcher: lobby(lists) })).games.find((x) => x.id === genuine.id);

test('the honest majority keeps the game\'s title and icon; the one node naming another loses', async () => {
  const lists = {
    'http://evil': { games: [{ ...genuine, title: EVIL, icon: 'evil.svg' }] },
    'http://a': { games: [{ ...genuine, title: 'Tick Tock, Next Block', icon: '/nb.svg' }] },
    'http://b': { games: [{ ...genuine, title: 'Tick Tock, Next Block', icon: '/nb.svg' }] },
  };
  const g = await tile(lists);
  assert.equal(g.title, 'Tick Tock, Next Block');
  assert.equal(g.icon, 'http://a/nb.svg', 'the icon from the first address that named the agreed one');
  assert.equal(g.nodes.length, 3);
});

test('one node alone among nodes that do not list the game does not title it', async () => {
  const g = await tile({ 'http://evil': { games: [{ ...genuine, title: EVIL, icon: 'evil.svg' }] }, 'http://a': { games: [] }, 'http://b': { games: [] } });
  assert.equal(g.title, NEXTBLOCK.manifest.gameName);
  assert.equal(g.icon, null);
});

test('a node naming another node\'s key does not push that node\'s title out of the count', async () => {
  const key = 'ab'.repeat(32);
  const g = await tile({
    'http://evil': { node: key, games: [{ ...genuine, title: EVIL }] },
    'http://a': { node: key, games: [{ ...genuine, title: 'Tick Tock, Next Block' }] },
  });
  assert.doesNotMatch(g.title, /evil/);
  assert.equal(g.nodes.length, 1, 'still hosted once per node key');
});

test('two addresses of one evil node each count once, and still lose to three honest ones', async () => {
  const g = await tile({
    'http://evil1': { games: [{ ...genuine, title: EVIL }] }, 'http://evil2': { games: [{ ...genuine, title: EVIL }] },
    'http://a': { games: [{ ...genuine, title: 'Tick Tock, Next Block' }] }, 'http://b': { games: [{ ...genuine, title: 'Tick Tock, Next Block' }] },
    'http://c': { games: [{ ...genuine, title: 'Tick Tock, Next Block' }] },
  });
  assert.equal(g.title, 'Tick Tock, Next Block');
});
