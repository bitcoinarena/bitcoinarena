// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2658: a protocol-28 RPS round seated by 6 - the client reads its lock-set certificate with the seats' own threshold rule, not a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSetOfSeats, lockSetThreshold } from '../src/head-to-head.js';

test('the lock set of a 6-seat committee is read, with the seats\' majority threshold', async () => {
  assert.equal(lockSetThreshold(7), 5);
  assert.equal(lockSetThreshold(2), 2);
  assert.equal(lockSetThreshold(6), 4);
  const committee = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(64).slice(0, 64));
  const fetcher = async () => new Response(JSON.stringify({ required: true, certificate: 'ab'.repeat(40) }), { status: 200 });
  const got = await lockSetOfSeats({ roundIdHex: '11'.repeat(32), nodes: ['http://a', 'http://b'], committee, verify: () => false, entryCloseMs: 1, fetcher });
  assert.equal(got.required, true);
  assert.equal(got.certified, null);
});
