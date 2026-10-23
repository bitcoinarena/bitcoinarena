// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A slow seat does not hold up the handout (playtest 2026-10-23, "First order is always slow second is <1s"): answered once enough seats took
// it, the slow one's answer in the background, and its entry posted only after its handout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postHandout } from '../src/join.js';

test('postHandout answers once the needed seats took it; a slow seat answers in the background', async () => {
  let release; const slow = new Promise((r) => { release = r; });
  const fetcher = async (url) => { if (url.startsWith('http://slow')) await slow; return { ok: true, status: 201, text: async () => '' }; };
  const t0 = Date.now();
  const put = await postHandout({ body: new Uint8Array(1) }, ['http://a', 'http://b', 'http://slow'], { fetcher, needed: 2, graceMs: 20 });
  assert.ok(Date.now() - t0 < 1000, 'not waited on the slow seat');
  assert.deepEqual([put.ok, put.accepted], [true, 2]);
  release();
  assert.equal((await put.rest).filter((a) => a.ok).length, 3, 'the slow seat took it later');
});

test('postHandout still refuses a stake too few seats took', async () => {
  const fetcher = async (url) => (url.startsWith('http://a') ? { ok: true, status: 201, text: async () => '' } : { ok: false, status: 400, text: async () => 'no' });
  const put = await postHandout({ body: new Uint8Array(1) }, ['http://a', 'http://b', 'http://c'], { fetcher, needed: 2, graceMs: 20 });
  assert.deepEqual([put.ok, put.accepted], [false, 1]);
});
