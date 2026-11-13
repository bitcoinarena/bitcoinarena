// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit #1489 r13 (client): ONE SEAT'S GET /games ANSWER IS NOT BOUNDED. fetchGames reads every listed game of every seat: each one is
// decoded, hashed (gameIdOf) and - since #1810 - its developer signature checked (one Ed25519 verify per distinct id), and every one that
// stands becomes a tile. One seat listing thousands of made-up manifests (each its own id: another version, another name) costs the page one
// decode + hash + verify each, on every games read, and - signed under the seat's own throwaway developer key - fills the lobby with tiles.
// Safe: one seat's answer is bounded - at most a fixed number of its games is decoded and checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames } from '../src/games.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });

test('one seat listing thousands of made-up games costs the page a bounded number of signature checks', async () => {
  const real = NEXTBLOCK.manifest;
  const listed = (m) => ({ id: toHex(gameIdOf(m)), title: m.gameName, icon: null, manifest: toHex(encodeManifest(m)) });
  const junk = Array.from({ length: 2000 }, (_, i) => listed({ ...real, version: (real.version || 0) + 1 + i, signature: new Uint8Array(real.signature.length) }));
  let verifies = 0;
  const verify = async () => { verifies++; return false; };
  const fetcher = async (url) => {
    if (url.startsWith('http://honest')) return answer({ games: [listed(real)] });
    if (url === 'http://liar/games') return answer({ games: junk });
    throw new Error('no such node');
  };
  const got = await fetchGames({ nodes: ['http://honest1', 'http://honest2', 'http://liar'], fetcher, verify });
  assert.ok(verifies <= 64, `one seat's /games answer cost ${verifies} developer-signature checks (and ${got.refused.length} refusals kept) in one games read`);
});
