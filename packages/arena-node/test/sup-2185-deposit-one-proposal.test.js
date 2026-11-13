// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2185 (#1489 a44-refute-89-s1, refuting #1840), adapted to 1.9 by #2536: a bonded stranger naming the same deposit at another seat
// (or a second body of the proposer, posted to another seat in the last review block) split the seats - each counted the proposal it heard of
// first. The card's tests read every deposit unbound; 1.9 reads it bound on every live network (#2125 / #2562: the deposit commits to its
// proposer key and body; #2607: a twin - the same body re-signed - is the same proposal). The same posts on the bound reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seat, proposal, BLOCK, ids, countedIds, secretC, P_CONFIG } from './sup-common89-bound.mjs';

test('#2185 (1.9): a stranger naming the same deposit at another seat is refused there, and both seats count the same proposal', async () => {
  const A = proposal(208, P_CONFIG);
  const C = proposal(208, Uint8Array.of(9, 9, 9), secretC);
  const t1 = { h: 200 }, t2 = { h: 200 };
  const s1 = seat(t1), s2 = seat(t2);
  const a1 = await s1.add({ proposal: A, blockHash: BLOCK });
  const c2 = await s2.add({ proposal: C, blockHash: BLOCK });
  await s1.pull(s2.list()); await s2.pull(s1.list());
  const a2 = await s2.add({ proposal: A, blockHash: BLOCK });
  console.log('  MEASURED', JSON.stringify({ a1: a1.status, c2: [c2.status, c2.why], a2: a2.status, seat1: countedIds(s1), seat2: countedIds(s2) }));
  assert.equal(a1.status, 201, a1.why);
  assert.equal(c2.status, 422, 'a stranger\'s proposal over A\'s deposit was taken');
  assert.match(c2.why, /another proposer/);
  assert.deepEqual(countedIds(s1), countedIds(s2), 'two seats count different proposals for one deposit');
  assert.equal(countedIds(s1).length, 1);
});

test('#2185 (1.9): a second body of the proposer over one deposit, posted to the other seat in the last review block, is refused; a twin is the same proposal', async () => {
  const A = proposal(208, P_CONFIG);
  const B = proposal(208, Uint8Array.of(4, 5, 6));
  const A2 = proposal(208, P_CONFIG, undefined, 7);              // the same body re-signed: a twin (#2607)
  const t1 = { h: 200 }, t2 = { h: 200 };
  const s1 = seat(t1), s2 = seat(t2);
  const a1 = await s1.add({ proposal: A, blockHash: BLOCK });
  const b2 = await s2.add({ proposal: B, blockHash: BLOCK });
  const tw = await s2.add({ proposal: A2, blockHash: BLOCK });
  t1.h = 205; t2.h = 205;
  await s1.pull(s2.list()); await s2.pull(s1.list());
  console.log('  MEASURED', JSON.stringify({ a1: a1.status, b2: [b2.status, b2.why], twin: tw.status, seat1: [ids(s1), countedIds(s1)], seat2: [ids(s2), countedIds(s2)] }));
  assert.equal(b2.status, 422, 'a second body over one bound deposit was taken');
  assert.match(b2.why, /another proposal/);
  assert.equal(tw.status, 201, tw.why);
  assert.equal(countedIds(s1).length, 1); assert.equal(countedIds(s2).length, 1);
});
