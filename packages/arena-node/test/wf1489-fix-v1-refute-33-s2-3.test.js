// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

// kanban #1950 (#1489 v1-refute-33 s2): A HAND-ON STILL DUE SURVIVES A RESTART. The cancel the player's door took is kept with its hand-on in
// market_cancel_handons; the seat that reopens its store finds it due and retries it until it is done (every peer holds it, or the close came).
test('a pending cancel hand-on is read back after the store is reopened, and is over once marked done', () => {
  const db = openStore(':memory:');
  const r1 = new Round(db, () => 1000);
  const roundId = new Uint8Array(32).fill(7), entryId = new Uint8Array(32).fill(8), signature = new Uint8Array(64).fill(9);
  assert.equal(r1.putCancel({ roundId, entryId, signature, receivedMs: 1000 }), true);
  assert.equal(r1.putCancelHandOn({ roundId, entryId, closeMs: 60000n }), true);
  assert.equal(r1.putCancelHandOn({ roundId, entryId, closeMs: 60000n }), false, 'kept once');
  const r2 = new Round(db, () => 2000);   // the seat after a restart: the same database
  const due = r2.cancelHandOnsDue();
  assert.equal(due.length, 1);
  assert.deepEqual([...due[0].entryId], [...entryId]);
  assert.deepEqual([...due[0].signature], [...signature]);
  assert.equal(due[0].closeMs, 60000);
  r2.cancelHandOnDone(entryId);
  assert.equal(r2.cancelHandOnsDue().length, 0);
  assert.equal(r2.cancelled(entryId), true, 'the cancel itself stays');
});
