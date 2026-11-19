// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3010 (feedback #348): an RPS tap with 7-9 s left was "too late" - the census was asked of the seats one after another, each read
// allowed 30 s, so a slow seat early in the list held the tap. Now every seat is asked at once and the first two distinct answers are taken;
// still two providers are required, and with fewer the census is for looking only, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFor } from '../src/committee.js';

const contract = { censusRoot: new Uint8Array(32).fill(0x31) };
const nodes = ['https://h/guardian-1', 'https://h/guardian-2', 'https://h/guardian-3', 'https://h/fed2-7'];
const entries = [{ txid: 'aa'.repeat(32), vout: 0 }];
const fetcherWith = (slow, never = new Set()) => async (url, opts) => {
  const node = nodes.find((n) => url.startsWith(n));
  if (never.has(node)) return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('signal timed out'))));
  if (slow.has(node)) await new Promise((r) => setTimeout(r, 3000));
  return new Response(JSON.stringify({ entries }), { status: 200 });
};

test('#3010: a slow first seat does not hold the census - two other seats answer and it is taken at once', async () => {
  const t0 = Date.now();
  const e = await evidenceFor('b1'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x41) }, nodes, { fetcher: fetcherWith(new Set(['https://h/guardian-1', 'https://h/guardian-2'])) });
  const ms = Date.now() - t0;
  assert.equal(e.ok, true);
  assert.deepEqual(e.fromNodes.sort(), ['https://h/fed2-7', 'https://h/guardian-3']);
  assert.ok(ms < 1000, `waited ${ms} ms on the slow seats`);
});

test('#3010: still two providers required - with one answering (the rest never), it is for looking only', async () => {
  const never = new Set(['https://h/guardian-2', 'https://h/guardian-3', 'https://h/fed2-7']);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
  const f = fetcherWith(new Set(), never);
  const e = await evidenceFor('b2'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x42) }, nodes, { fetcher: (u, o) => f(u, { ...o, signal: ac.signal }) });
  assert.equal(e.ok, false);
  assert.equal(e.lookOnly, true);
});
