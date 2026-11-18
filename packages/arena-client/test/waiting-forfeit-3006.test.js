// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3006 (feedback #346): a stake no signer node forfeits waited with no word of when it comes back; the waiting answer now
// carries the locks' latest expiry, the block from which the player's own key takes them back (§23.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingForfeit } from '../src/page-lock.js';

test('#3006: a stake waiting for a forfeit says the block it comes back from', () => {
  const locks = [{ fields: { expiration: 161950, amountMsat: '90000' } }, { fields: { expiration: 161952, amountMsat: '4000' } }];
  const w = waitingForfeit(locks, 94000n, 'no signer node gave a forfeit of this lock');
  assert.deepEqual(w, { state: 'waiting', how: 'forfeit', refused: true, msat: 94000n, why: 'no signer node gave a forfeit of this lock', expiration: 161952 });
});

test('#3006: locks with no expiry read leave the answer as it was', () => {
  const w = waitingForfeit([{ fields: {} }], 5n, 'x');
  assert.equal('expiration' in w, false);
  assert.equal(w.state, 'waiting');
});
