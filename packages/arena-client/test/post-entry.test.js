// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A seat still taking the handout is asked again; any other refusal ends the join at once (kanban #828).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postEntry } from '../src/client.js';

const seat = (answers) => { let n = 0; const f = async () => { const a = answers[Math.min(n++, answers.length - 1)]; return { status: a[0], text: async () => a[1] }; }; f.asked = () => n; return f; };
const missing = [400, 'that entry names shares this node has not accepted: publish the handout first, and it is refused if it is not one polynomial'];

test('the entry waits for the seat to hold its handout', async () => {
  const f = seat([missing, missing, [201, '']]);
  const r = await postEntry('http://x/entry', new Uint8Array(1), { fetcher: f, waitMs: 1 });
  assert.equal(r.status, 201); assert.equal(f.asked(), 3);
});
test('another refusal is not asked again', async () => {
  const f = seat([[400, 'the round is closed']]);
  await assert.rejects(postEntry('http://x/entry', new Uint8Array(1), { fetcher: f, waitMs: 1 }), /the node refused the entry: the round is closed/);
  assert.equal(f.asked(), 1);
});
test('a handout that never comes ends after its tries', async () => {
  const f = seat([missing]);
  await assert.rejects(postEntry('http://x/entry', new Uint8Array(1), { fetcher: f, tries: 4, waitMs: 1 }), /publish the handout first/);
  assert.equal(f.asked(), 4);
});
test('a seat whose seating certificate is still on its way is asked again (Daniel 2026-11-10, round 0ff01991)', async () => {
  const notSeated = [409, 'entry refused: that round is not seated yet - no seating certificate for its game and settlement roles (§5A.7)'];
  const f = seat([notSeated, notSeated, missing, [201, '']]);
  const r = await postEntry('http://x/entry', new Uint8Array(1), { fetcher: f, waitMs: 1 });
  assert.equal(r.status, 201); assert.equal(f.asked(), 4);
});
