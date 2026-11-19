// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3009 (feedback #347): an Up/Down order that matched nobody. Its record stayed "collected in part, still open: payout waiting" for good
// (a market where nothing filled never settles), and a collect pass reached it only after the other records (~60 s after load, measured live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectState, collectOrder } from '../src/page-lock.js';

test('#3009: a stake back by its forfeit closes the record - there is no payout to wait for', () => {
  const look = { payout: { state: 'waiting', why: 'no signer node holds an accepted settlement of this round yet' }, stake: { state: 'owed', how: 'forfeit', msat: 99000n }, inTabMsat: 0n };
  assert.equal(collectState(look, null).state, 'open', 'before the collect credited it: open');
  assert.equal(collectState(look, { got: { stake: { ok: true } } }).state, 'done', 'after the collect credited the stake: done');
  // a stake owed by settlement (a counted entry) still waits for its payout
  const counted = { payout: { state: 'waiting' }, stake: { state: 'owed', how: 'settlement', msat: 99000n }, inTabMsat: 0n };
  assert.equal(collectState(counted, { got: { stake: { ok: true } } }).state, 'open');
});

test('#3009: a collect pass takes the unmatched orders first, the rest in their kept order', () => {
  const recs = [{ roundIdHex: 'AA', order: 0 }, { roundIdHex: 'bb', order: 0 }, { roundIdHex: 'cc', order: 1 }, { roundIdHex: 'cc', order: 0 }];
  const out = collectOrder(recs, new Set(['cc:1', 'bb:0']));
  assert.deepEqual(out.map((r) => `${r.roundIdHex}:${r.order}`), ['bb:0', 'cc:1', 'AA:0', 'cc:0']);
  assert.deepEqual(collectOrder(recs).map((r) => r.roundIdHex), ['AA', 'bb', 'cc', 'cc'], 'none unmatched: the order is unchanged');
});
