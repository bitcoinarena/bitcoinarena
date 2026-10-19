// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE KEPT VALUES MOVE TO THEIR arena- NAMES ONCE (kanban #522): a donation record and a liquidation claim kept under the old blwp- name
// are read under the arena- name; the old value is copied once, never over a newer arena- value, and the old key is gone after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movedKey } from '../src/storage-keys.js';
import { donationPaidKey, donationPaidRecord } from '../src/donation-pay.js';
import { pendingClaimKey, pendingRequestsKey } from '../src/liquidation-claim.js';

const store = (init = {}) => { const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('an old blwp- key is copied to its arena- key once, and the old key is gone', () => {
  const s = store({ 'blwp-ghost-clock-x': 'old' });
  assert.equal(movedKey(s, 'arena-ghost-clock-x'), 'arena-ghost-clock-x');
  assert.deepEqual([s.getItem('arena-ghost-clock-x'), s.getItem('blwp-ghost-clock-x')], ['old', null]);
  movedKey(s, 'arena-ghost-clock-x');
  assert.equal(s.getItem('arena-ghost-clock-x'), 'old', 'a second load changes nothing');
});

test('a second load does not clobber a newer arena- value, even when an old tab wrote the old key again', () => {
  const s = store({ 'blwp-liquidation-pending-ab': 'old' });
  movedKey(s, 'arena-liquidation-pending-ab');
  s.setItem('arena-liquidation-pending-ab', 'newer');
  s.setItem('blwp-liquidation-pending-ab', 'stale');          // a tab still on the old page
  movedKey(s, 'arena-liquidation-pending-ab');
  assert.deepEqual([s.getItem('arena-liquidation-pending-ab'), s.getItem('blwp-liquidation-pending-ab')], ['newer', null]);
});

test('a claim removed after it was paid does not come back from its old copy', () => {
  const s = store({ 'blwp-liquidation-ecash-ab': 'notes' });
  movedKey(s, pendingClaimKey('AB'));
  s.removeItem(pendingClaimKey('AB'));                       // presented and taken
  movedKey(s, pendingClaimKey('AB'));
  assert.equal(s.getItem(pendingClaimKey('AB')), null);
});

test('the four storage names are arena- now, and a donation record kept under the old name is read', () => {
  assert.match(pendingClaimKey('AB'), /^arena-liquidation-ecash-ab$/);
  assert.match(pendingRequestsKey('AB'), /^arena-liquidation-pending-ab$/);
  const whose = { roundId: new Uint8Array(32).fill(1), playerPubkey: new Uint8Array(32).fill(2) };
  assert.match(donationPaidKey(whose), /^arena-donation-paid:0101/);
  const rec = JSON.stringify({ shares: { lnurl1: { amountMsat: '1000', state: 'paid' } } });
  const s = store({ ['blwp-donation-paid:' + donationPaidKey(whose).slice('arena-donation-paid:'.length)]: rec });
  assert.deepEqual(donationPaidRecord(s, whose), JSON.parse(rec));
  assert.equal(s.getItem(donationPaidKey(whose)), rec, 'kept under the arena- name from now on');
  assert.equal([...s.m.keys()].some((k) => k.startsWith('blwp-')), false);
  assert.equal(movedKey(null, 'arena-x'), 'arena-x', 'no storage: the key as it is');
});
