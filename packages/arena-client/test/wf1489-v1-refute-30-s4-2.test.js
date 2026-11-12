// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2068, #1524, #625 (wf1489 v1 refute-30 s4): the grace timer counts what an answer claims, not its bytes - two seats serving
// the same approved set with their approvals in another order are a majority of three, and a stalled third seat costs 250 ms, not 6 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstMajority, QUORUM_GRACE_MS } from '../src/donation-pay.js';

const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const A = enc({ approved: true, root: 'aa', chain: [{ proposal: 'bb', approvals: ['01', '02'] }], admin: 'cc' });
const B = enc({ approved: true, root: 'aa', chain: [{ proposal: 'bb', approvals: ['02', '01'] }], admin: 'cc' });
const C = enc({ approved: true, root: 'aa', chain: [{ proposal: 'bd', approvals: ['01'] }], admin: 'cc' });

test('two answers naming the same approved set in other bytes start the grace timer', async () => {
  const hang = new Promise(() => {});
  const t0 = Date.now();
  const got = await firstMajority([Promise.resolve({ node: 'a', bytes: A }), Promise.resolve({ node: 'b', bytes: B }), hang], ['a', 'b', 'c']);
  const ms = Date.now() - t0;
  assert.ok(ms < QUORUM_GRACE_MS + 1000, `held ${ms} ms`);
  assert.equal(got[2].late, true);
});

test('control: answers naming different proposals are no majority', async () => {
  let fired = false;
  const p = firstMajority([Promise.resolve({ node: 'a', bytes: A }), Promise.resolve({ node: 'b', bytes: C }), new Promise(() => {})], ['a', 'b', 'c'], { graceMs: 10 })
    .then(() => { fired = true; });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fired, false, 'two different claims of three started the timer');
  void p;
});
