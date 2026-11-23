// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3073 (feedback #349): main never had the 1.9 census read guards. A provider listing one bond twice is refused on its own (its honest
// co-providers are still taken), and a census answer past CENSUS_ANSWER_MAX is refused, not read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFor } from '../src/committee.js';

const nodes = ['https://h/a', 'https://h/b', 'https://h/c'];
const one = { txid: 'aa'.repeat(32), vout: 0 };

test('#3073: a provider listing one bond twice is refused; the two honest providers are taken', async () => {
  const fetcher = async (url) => new Response(JSON.stringify({ entries: url.startsWith('https://h/a') ? [one, { ...one }] : [one] }), { status: 200 });
  const e = await evidenceFor('c1'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x51) }, nodes, { fetcher });
  assert.deepEqual([...e.fromNodes].sort(), ['https://h/b', 'https://h/c']);
  assert.ok((e.refused || []).some((r) => /lists one bond twice/.test(r)), JSON.stringify(e.refused));
});

test('#3073: a census answer larger than the cap is refused', async () => {
  const big = JSON.stringify({ entries: [one], pad: ' '.repeat(5 * 1024 * 1024) });
  const fetcher = async (url) => new Response(url.startsWith('https://h/a') ? big : JSON.stringify({ entries: [one] }), { status: 200 });
  const e = await evidenceFor('c2'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x52) }, nodes, { fetcher });
  assert.ok(!e.fromNodes.includes('https://h/a'));
  assert.ok((e.refused || []).some((r) => /more than/.test(r)), JSON.stringify(e.refused));
});
