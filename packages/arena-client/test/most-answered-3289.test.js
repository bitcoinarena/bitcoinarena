// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3289 (owner 2026-11-22: "Das Laden und das Rundenbeitreten ist sehr langsam"): measured on the live page, two of the 14 seats
// (guardian-2, guardian-3) never answered, and every load waited them out - GET /games its full 2.5 s, the lobby's /rounds 2.5 s after
// half had answered - while the twelve others had answered within 0.4 s. Once three quarters of the seats have answered, the rest get
// a short time more; what counts (a manifest's hash and signature, a round's own signer nodes) is unchanged, a late seat is in the
// next read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames, GAMES_MOST_MS } from '../src/games.js';
import { fetchLobby, LOBBY_MOST_MS, LOBBY_LAST_MS } from '../src/lobby.js';
import { MARKET } from '../../arena-node/test/plugins/market/index.js';
const NEXTBLOCK = MARKET.registration;
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const nodes = Array.from({ length: 8 }, (_, i) => `http://s${i}`);
const slowFetcher = (slow, body) => (url, opts = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(new Response(JSON.stringify(body()), { status: 200 })), slow.has(new URL(url).origin) ? 8000 : 40);
  if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
});

test('games: seven of eight seats answered, the eighth silent - read after a short time more, not the whole 2.5 s', async () => {
  const listed = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, title: NEXTBLOCK.title || NEXTBLOCK.name, icon: null, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };
  const t0 = Date.now();
  const got = await fetchGames({ nodes, fetcher: slowFetcher(new Set(['http://s7']), () => ({ games: [listed] })), answerMs: 2500, verify: () => true });
  const took = Date.now() - t0;
  assert.ok(took < 40 + GAMES_MOST_MS + 400, `read after ${took} ms`);
  assert.equal(got.games.length, 1);
  assert.deepEqual(got.games[0].nodes, nodes.slice(0, 7));
  assert.ok(got.refused.some((r) => r.startsWith('http://s7:')), got.refused.join('\n'));
});

test('games: half of the seats silent - each still gets its whole limit', async () => {
  const listed = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, title: NEXTBLOCK.title || NEXTBLOCK.name, icon: null, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };
  const t0 = Date.now();
  await fetchGames({ nodes, fetcher: slowFetcher(new Set(['http://s4', 'http://s5', 'http://s6', 'http://s7']), () => ({ games: [listed] })), answerMs: 1200, verify: () => true });
  assert.ok(Date.now() - t0 >= 1150, 'not cut short');
});

test('lobby: seven of eight seats answered - the eighth gets a short time more, not 2.5 s', async () => {
  const t0 = Date.now();
  const got = await fetchLobby({ nodes, fetcher: slowFetcher(new Set(['http://s7']), () => ({ node: 'ab'.repeat(32), nowMs: Date.now(), rounds: [] })), verify: () => true, answerMs: 10000 });
  const took = Date.now() - t0;
  assert.ok(LOBBY_MOST_MS < LOBBY_LAST_MS);
  assert.ok(took < 40 + LOBBY_MOST_MS + 400, `drawn after ${took} ms`);
  assert.deepEqual(got.unanswered, ['http://s7']);
});

test('lobby: half of the seats answered at once, the other half silent - the rest get twice that time (at least 0.5 s), not 2.5 s', async () => {
  const t0 = Date.now();
  const got = await fetchLobby({ nodes, fetcher: slowFetcher(new Set(['http://s4', 'http://s5', 'http://s6', 'http://s7']), () => ({ node: 'ab'.repeat(32), nowMs: Date.now(), rounds: [] })), verify: () => true, answerMs: 10000 });
  const took = Date.now() - t0;
  assert.ok(took < 40 + LOBBY_MOST_MS + 400, `drawn after ${took} ms`);
  assert.equal(got.unanswered.length, 4);
});

test('lobby: the first half took 1.5 s - the rest still get the whole 2.5 s', async () => {
  const late = (url, opts = {}) => new Promise((resolve, reject) => {
    const o = new URL(url).origin, ms = ['http://s4', 'http://s5', 'http://s6', 'http://s7'].includes(o) ? 3700 : 1500;
    const t = setTimeout(() => resolve(new Response(JSON.stringify({ node: 'ab'.repeat(32), nowMs: Date.now(), rounds: [] }), { status: 200 })), ms);
    if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
  const got = await fetchLobby({ nodes, fetcher: late, verify: () => true, answerMs: 10000 });
  assert.deepEqual(got.unanswered, [], 'the slower half came in within 2.5 s of the first and counts');
});
