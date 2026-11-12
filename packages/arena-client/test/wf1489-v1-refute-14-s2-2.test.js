// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 REFUTE 14 (skeptic 2), ROLE: ONE SEAT. The cap of a seat's /settled list is taken AFTER the whole list is filtered, mapped
// and sorted on the page's thread (all.map(...).sort(...).slice(0, cap)): one seat answering with a million tiny entries costs the
// page an O(n log n) sort of all of them at every load, the work the cap was meant to bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { pageCurve } from '../src/page-curve.js';

const seed = new Uint8Array(32).fill(7);

test('wf1489-v1-refute-14-s2-2: one seat listing 1,000,000 entries costs the page no more than its 500-round cap', async () => {
  const many = Array.from({ length: 1_000_000 }, (_, i) => ({ madeMs: (i * 7919) % 1000003 }));
  const honest = { ok: true, json: async () => ({ rounds: [] }) };
  const fetcher = async (url) => (url.startsWith('https://liar') ? { ok: true, json: async () => ({ rounds: many }) } : honest);
  PL.forgetOwedRounds();
  let t0 = Date.now();
  await PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://h1'], fetcher, sinceMs: 0 });
  const base = Date.now() - t0;
  t0 = Date.now();
  await PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://liar', 'https://h1'], fetcher, sinceMs: 0 });
  const ms = Date.now() - t0;
  console.log(`  FACTS one seat listing 1,000,000 entries: ${ms} ms of the page's thread (honest only: ${base} ms)`);
  assert.ok(ms < 500, `one seat's oversized list cost the page ${ms} ms before the cap was applied`);
});
