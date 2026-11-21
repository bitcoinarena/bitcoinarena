// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3009 (feedback #347): an Up/Down order that matched nobody. Its record stayed "collected in part, still open: payout waiting" for good
// (a market where nothing filled never settles), and a collect pass reached it only after the other records (~60 s after load, measured live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectState, collectOrder } from '../src/page-lock.js';

test('#3009: collectState does not close a record on a forfeit stake alone - a winner\'s stake comes back by forfeit too and its payout is still owed', () => {
  const look = { payout: { state: 'waiting', why: 'no signer node holds an accepted settlement of this round yet' }, stake: { state: 'owed', how: 'forfeit', msat: 99000n }, inTabMsat: 0n };
  assert.equal(collectState(look, { got: { stake: { ok: true } } }).state, 'open', 'the page closes a refund-only order itself (index.html refundOrderKeys), never collectState on the forfeit');
});

test('#3009: a collect pass takes the unmatched orders first, the rest in their kept order', () => {
  const recs = [{ roundIdHex: 'AA', order: 0 }, { roundIdHex: 'bb', order: 0 }, { roundIdHex: 'cc', order: 1 }, { roundIdHex: 'cc', order: 0 }];
  const out = collectOrder(recs, new Set(['cc:1', 'bb:0']));
  assert.deepEqual(out.map((r) => `${r.roundIdHex}:${r.order}`), ['bb:0', 'cc:1', 'AA:0', 'cc:0']);
  assert.deepEqual(collectOrder(recs).map((r) => r.roundIdHex), ['AA', 'bb', 'cc', 'cc'], 'none unmatched: the order is unchanged');
});

test('#3009: a VOID market line is in transit until this browser credited the stake', async () => {
  const { marketLines } = await import('../src/market.js');
  const market = { name: 'm', outcomes: ['Up', 'Down'], terms: null, gameSource: true };
  const p = { roundIdHex: 'aa'.repeat(32), entryIdHex: 'bb'.repeat(32), pick: 0, stakeMsat: '99000', entryCloseMs: '1', market };
  const outcomes = new Map([[p.roundIdHex, { state: 'VOID', why: 'no outcome was attested by the market deadline' }]]);
  const [transit] = marketLines({ picks: [{ ...p, stakeBack: false }], outcomes, nowMs: 10 });
  assert.deepEqual([transit.state, transit.final], ['refund in transit', false]);
  const [credited] = marketLines({ picks: [{ ...p, stakeBack: true }], outcomes, nowMs: 10 });
  assert.deepEqual([credited.state, credited.final], ['void', true]);
});
