// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE WHOSE READ FAILED IS SKIPPED FOR FAILED_NODE_SKIP_MS (kanban #1133): every lobby read on the owner's iPhone asked the stopped T3
// seats and the dead quick tunnels of its kept list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby, FAILED_NODE_SKIP_MS, FAILED_NODE_FIRST_SKIP_MS, forgetSkippedNodes, skippedNodes } from '../src/lobby.js';

const t0 = 1_800_000_000_000;
const verify = () => true;
const lobbyOf = (asks, deadNow) => async (url) => {
  const u = String(url);
  const node = u.replace(/\/(rounds|round)\?.*$/, '');
  if (u.includes('/rounds')) asks.push(node);
  if (deadNow.has(node)) throw new TypeError('Load failed');
  if (node === 'http://t3') return new Response('bad gateway', { status: 502 });
  if (u.includes('/rounds')) return new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: String(t0), rounds: [] }));
  return new Response('no', { status: 404 });
};

test('a failed node is skipped FAILED_NODE_FIRST_SKIP_MS, doubled for each failure in a row up to FAILED_NODE_SKIP_MS; one that answers is out of the list at once (#1133, #1391)', async () => {
  forgetSkippedNodes();
  const dead = new Set(['http://tunnel']);
  const nodes = ['http://tunnel', 'http://t3', 'http://live'];
  let asks = [];
  const first = await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf(asks, dead), verify, nowMs: t0 });
  assert.deepEqual([...asks].sort(), ['http://live', 'http://t3', 'http://tunnel']);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(skippedNodes(t0).map((x) => x.node).sort(), ['http://t3', 'http://tunnel']);
  assert.ok(skippedNodes(t0).every((x) => x.untilMs === t0 + FAILED_NODE_FIRST_SKIP_MS), 'one failure: the short skip (kanban #1391)');

  asks = [];
  const second = await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf(asks, dead), verify, nowMs: t0 + 1000 });
  assert.deepEqual(asks, ['http://live'], 'a node that failed was asked again within its skip');
  assert.deepEqual([...second.skipped].sort(), ['http://t3', 'http://tunnel']);

  // after the short skip: asked again; the tunnel is back up and leaves the list, T3 still answers 502 and is skipped twice as long
  dead.delete('http://tunnel');
  asks = [];
  let at = t0 + FAILED_NODE_FIRST_SKIP_MS + 1;
  await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf(asks, dead), verify, nowMs: at });
  assert.deepEqual([...asks].sort(), ['http://live', 'http://t3', 'http://tunnel']);
  assert.deepEqual(skippedNodes(at + 1).map((x) => x.node), ['http://t3']);
  assert.equal(skippedNodes(at + 1)[0].untilMs, at + 2 * FAILED_NODE_FIRST_SKIP_MS, 'the second failure in a row doubles it');
  // a node that keeps failing reaches FAILED_NODE_SKIP_MS and stays there
  for (let i = 0; i < 8; i++) { at = skippedNodes(at + 1)[0].untilMs + 1; await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf([], dead), verify, nowMs: at }); }
  assert.equal(skippedNodes(at + 1)[0].untilMs, at + FAILED_NODE_SKIP_MS, 'capped at the long skip');
});

test('when every node of a read would be skipped, all of them are asked', async () => {
  forgetSkippedNodes();
  const dead = new Set(['http://a', 'http://b']);
  const nodes = ['http://a', 'http://b'];
  await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf([], dead), verify, nowMs: t0 }).catch(() => null);
  const asks = [];
  await fetchLobby({ skipFailed: true, nodes, fetcher: lobbyOf(asks, dead), verify, nowMs: t0 + 1000 }).catch(() => null);
  assert.deepEqual([...asks].sort(), ['http://a', 'http://b']);
});

test('without skipFailed a failed node is asked on every read, as before', async () => {
  forgetSkippedNodes();
  const dead = new Set(['http://x']);
  const nodes = ['http://x', 'http://live'];
  await fetchLobby({ nodes, fetcher: lobbyOf([], dead), verify, nowMs: t0 });
  const asks = [];
  await fetchLobby({ nodes, fetcher: lobbyOf(asks, dead), verify, nowMs: t0 + 1000 });
  assert.deepEqual([...asks].sort(), ['http://live', 'http://x']);
});
