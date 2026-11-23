// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2478 (#1489 a44-refute-89-s2, on #2185's contest window), adapted to 1.9 by #2536: a competitor posted to one seat in the last voting
// block voided A there but not at the seat that pulled it a block later (refused by the tip check); and a seat back from a restart after the
// voting phase never learned of a contest the other seat held. On 1.9's bound reading a competitor over A's deposit is refused at every seat,
// whenever it comes, and A itself is taken at any tip (#2125: the commitment, not the seat's tip, fixes it). The same timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seat, proposal, BLOCK, ids, countedIds, secretC, P_CONFIG } from './sup-common89-bound.mjs';

test('#2478 (1.9): a competitor posted to one seat in the last voting block is refused there and at the seat that pulls a block later', async () => {
  const A = proposal(208, P_CONFIG);
  const C = proposal(208, Uint8Array.of(9, 9, 9), secretC);
  const t1 = { h: 200 }, t2 = { h: 200 };
  const s1 = seat(t1), s2 = seat(t2);
  assert.deepEqual([(await s1.add({ proposal: A, blockHash: BLOCK })).status, (await s2.add({ proposal: A, blockHash: BLOCK })).status], [201, 201]);
  t1.h = 206; t2.h = 206;
  const c2 = await s2.add({ proposal: C, blockHash: BLOCK });
  t1.h = 207; t2.h = 207;
  await s1.pull(s2.list()); await s2.pull(s1.list());
  const c1 = await s1.add({ proposal: C, blockHash: BLOCK });
  console.log('  MEASURED', JSON.stringify({ c2: [c2.status, c2.why], c1: c1.status, counted1: countedIds(s1), counted2: countedIds(s2) }));
  assert.equal(c2.status, 422); assert.equal(c1.status, 422);
  assert.deepEqual(countedIds(s1), countedIds(s2), 'two seats count different proposals for one deposit');
  assert.equal(countedIds(s1).length, 1);
});

test('#2478 (1.9): a seat back from a restart after the voting phase takes A from its peer and counts what the other seat counts', async () => {
  const A = proposal(208, P_CONFIG);
  const C = proposal(208, Uint8Array.of(9, 9, 9), secretC);
  const t1 = { h: 200 }, t2 = { h: 210 };                         // seat 2 was down through the whole phase
  const s1 = seat(t1);
  assert.equal((await s1.add({ proposal: A, blockHash: BLOCK })).status, 201);
  t1.h = 204;
  const c1 = await s1.add({ proposal: C, blockHash: BLOCK });
  t1.h = 210;
  const s2 = seat(t2);
  await s2.pull(s1.list());
  const a2 = await s2.add({ proposal: A, blockHash: BLOCK });
  console.log('  MEASURED', JSON.stringify({ c1: c1.status, a2: [a2.status, a2.why], seat1: [ids(s1), countedIds(s1)], seat2: [ids(s2), countedIds(s2)] }));
  assert.equal(c1.status, 422);
  assert.ok([200, 201].includes(a2.status), a2.why);
  assert.deepEqual(countedIds(s1), countedIds(s2));
  assert.equal(countedIds(s2).length, 1);
});
