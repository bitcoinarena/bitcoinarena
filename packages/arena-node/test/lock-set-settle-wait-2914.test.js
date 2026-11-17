// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2914: a seat settling a round at its entry close, before its peers have certified the lock set, keeps asking while the window is open
// (it signed every entry VOID after one empty pull: 7 of 64 two-entry RPS rounds split VOID/certified on 2026-11-17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LockSetBook, LOCK_SET_FINAL_AFTER_MS } from '../src/lock-set-book.js';
import { LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

const bookAt = (closeMs, certAfterPulls) => {
  const book = new LockSetBook({ round: { db: new DatabaseSync(':memory:'), now: () => Date.now(), pubkey: new Uint8Array(32) },
    peersOf: () => ['http://peer'], roundOf: () => ({ entryCloseMs: closeMs }), viewOf: () => null });
  let pulls = 0;
  book.pull = async () => { pulls++; };
  book.certified = () => (certAfterPulls !== null && pulls >= certAfterPulls ? { entries: ['a', 'b'] } : null);
  book.conflicted = () => false;
  return { book, pulls: () => pulls };
};

test('#2914: settled at the close, the certificate formed a moment later is found and played', async () => {
  const { book, pulls } = bookAt(Date.now(), 3);
  const cert = await book.settle(new Uint8Array(32));
  assert.deepEqual(cert, { entries: ['a', 'b'] }, 'the seat kept VOID after one empty pull');
  assert.equal(pulls(), 3);
});

test('#2914: with no certificate anywhere the seat stops asking when the window and its final 2 s are over', async () => {
  const t = Date.now();
  const { book, pulls } = bookAt(t - (LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS) + 600, null);
  assert.equal(await book.settle(new Uint8Array(32)), null);
  assert.ok(Date.now() - t < 2500, 'asked past the window');
  assert.ok(pulls() >= 2, 'asked only once');
});

test('#2914: a round settled long after its window is asked once, as before', async () => {
  const { book, pulls } = bookAt(Date.now() - 60000, null);
  assert.equal(await book.settle(new Uint8Array(32)), null);
  assert.equal(pulls(), 1);
});
