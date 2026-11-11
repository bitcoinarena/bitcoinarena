// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1451 (measured on live page983, 2026-11-11): the lobby paints every second and asked all 14 seats each time - 150-350 GET /rounds in 45 s from one
// idle page - while a seat keeps its listing 5 s and answers the same bytes until then. A seat's answer is reused for LOBBY_REREAD_MS (per fetcher), and a
// failed read is not kept: that seat is asked again at the next read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby, LOBBY_REREAD_MS } from '../src/lobby.js';

const listing = () => new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: '1', rounds: [] }));
const read = (fetcher, rereadMs = LOBBY_REREAD_MS) => fetchLobby({ nodes: ['http://n1', 'http://n2'], fetcher, verify: () => true, nowMs: 1_800_000_000_000, rereadMs });

test('two lobby reads within LOBBY_REREAD_MS ask each seat once (#1451)', async () => {
  assert.equal(LOBBY_REREAD_MS, 5000);
  let n = 0; const fetcher = async (u) => { if (String(u).includes('/rounds?')) n++; return listing(); };
  await read(fetcher); await read(fetcher); await read(fetcher);
  assert.equal(n, 2, 'each of the 2 seats once, not 6 times');
});

test('another fetcher asks for itself, and a failed answer is asked again at the next read (#1451)', async () => {
  let a = 0, b = 0;
  const fa = async (u) => { if (String(u).includes('/rounds?')) a++; return listing(); };
  const fb = async (u) => { if (String(u).includes('/rounds?')) b++; return String(u).startsWith('http://n2') ? new Response('busy', { status: 503 }) : listing(); };
  await read(fa); await read(fb); await read(fb);
  assert.equal(a, 2);
  assert.equal(b, 3, 'n1 once (kept), n2 twice (its 503 is never kept)');
});

test('without rereadMs every read asks every seat, as before (#1451)', async () => {
  let n = 0; const fetcher = async (u) => { if (String(u).includes('/rounds?')) n++; return listing(); };
  await read(fetcher, 0); await read(fetcher, 0);
  assert.equal(n, 4);
});

// measured on preview page986 (2026-11-11): the kept answer was also handed to a round's contract read, which reads it with arrayBuffer() - every
// contract read failed ("r.arrayBuffer is not a function") and the lobby showed no row at all. Only a seat's listing is kept.
test('with rereadMs, a listed round\'s contract is still read from the seat as before (#1451)', async () => {
  const id = 'ab'.repeat(32); let contractAsks = 0;
  const fetcher = async (u) => {
    const s = String(u);
    if (s.includes('/rounds?')) return new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: '1', rounds: [{ id, entryCloseMs: String(1_800_000_060_000), phase: 'open' }] }));
    if (s.includes('/round?')) { contractAsks++; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }
    return new Response('no', { status: 404 });
  };
  const got = await read(fetcher);
  assert.ok(contractAsks >= 1, 'the contract was asked of the seat');
  assert.ok(!(got.refused || []).some((w) => /arrayBuffer is not a function/.test(w)), `a contract read failed on a kept answer: ${(got.refused || []).join('; ')}`);
});
