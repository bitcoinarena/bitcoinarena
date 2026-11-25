// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FORFEIT IS ASKED OF EVERY SEAT AT ONCE (kanban #3745): one ask per source, each bounded, the first verified answer taken and the
// rest let go; without a check the list's order still decides, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forfeitOf } from '../src/page-lock.js';

const roundId = new Uint8Array(32).fill(7);
const sig = (c) => c.repeat(128);
const answer = (signature, ms = 0) => new Promise((ok) => setTimeout(() => ok(Response.json({ signature, contractId: 'c0'.repeat(32), claimPk: '02' + 'aa'.repeat(32) })), ms));
const hang = (opts) => new Promise((_, no) => opts.signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }));

test('with a check the first verified forfeit is taken at once and the seats still asked are let go', async () => {
  const aborted = [];
  const fetcher = (url, opts) => {
    if (url.startsWith('http://box.test')) { opts.signal.addEventListener('abort', () => aborted.push(url)); return hang(opts); }
    if (url.startsWith('http://bad.test')) return answer(sig('b'));
    return answer(sig('a'), 20);
  };
  const t0 = Date.now();
  const f = await forfeitOf({ roundId, entryId: 'ee'.repeat(32), fetcher, check: (j) => j.signature === sig('a'),
    nodes: [...Array.from({ length: 5 }, (_, i) => `http://box.test/s${i}`), 'http://bad.test', 'http://honest.test'] });
  assert.equal(f.ok, true);
  assert.equal(f.from, 'http://honest.test');
  assert.ok(Date.now() - t0 < 5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(aborted.length, 5, 'the box\'s hanging asks are aborted once the forfeit is in');
});

test('without a check the first seat of the list that answered gives it, even when a later one is faster', async () => {
  const fetcher = (url) => (url.startsWith('http://first.test') ? answer(sig('1'), 30) : answer(sig('2')));
  const f = await forfeitOf({ roundId, entryId: 'ee'.repeat(32), fetcher, nodes: ['http://first.test', 'http://second.test'] });
  assert.equal(f.signature, sig('1'));
});

test('spellings of one source are asked once; every refusal is said', async () => {
  const asked = [];
  const fetcher = async (url) => { asked.push(url); return new Response('that run is VOID with score 0', { status: 409 }); };
  const f = await forfeitOf({ roundId, entryId: 'ee'.repeat(32), fetcher, nodes: ['http://a.test', 'http://a.test/', 'http://a.test//', 'http://b.test/x'] });
  assert.equal(f.ok, false);
  assert.equal(asked.length, 2);
  assert.equal(f.refused.length, 2);
  assert.match(f.why, /a\.test: 409 that run is VOID/);
});
