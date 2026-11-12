// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 25 skeptic 3 (kanban #1523): sourceKey FOLDS DISTINCT SEATS INTO ONE VOTE.
// 07d83f3dd counts each named node by sourceKey (origin + FIRST path segment). Seats behind one host under a shared prefix
// (https://h/arena/seat-0 .. seat-5) are six seats but one "source", so the six honest seats are one vote of two against one
// liar elsewhere: 1 of 2, refused - the original #1523 attack (one seat of seven stops the world seed) works again for that
// layout, and on 85f803d70 the same seven answered with the six seats' beacon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRandomness } from '../src/join.js';

const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const NODES = [...Array.from({ length: 6 }, (_, i) => `https://h.example/arena/seat-${i}`), 'https://liar.example'];
const ok = (b) => ({ ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => b.buffer.slice(0), text: async () => '' });

test('six honest seats under one host prefix outvote one liar', async () => {
  const got = await fetchRandomness('ef'.repeat(32), NODES, { fetcher: async (u) => ok(String(u).startsWith('https://liar.example') ? BAD : GOOD) });
  assert.deepEqual([...got.randomness], [...GOOD]);
});
