// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CANCEL TAPPED WHILE THE ORDER IS STILL PLACING (kanban #3276, feedback #384, UI 726, round f271e55d 2026-11-22 08:13Z): the order was
// submitted at 4.6 s, the player cancelled it ~3.6 s later (every book seat took the cancel, 202; batch 3590670430 carried order and cancel),
// and at 14.4 s the page wrote the order again as 'placed' from a fresh record - without its `cancelled`. The order showed open again; the
// second tap got 409 "that cancel is already carried by batch ..." from every seat and the client said "Cancel refused".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const TEXT = readFileSync(PAGE, 'utf8');
// the page's statements from `from` up to (not with) the line that starts with `to`
const between = (from, to) => { const a = TEXT.indexOf(from); assert.ok(a >= 0, `the page holds no ${from}`); const b = TEXT.indexOf(to, a); assert.ok(b > a); return TEXT.slice(a, b); };
const E = '5c2b441c137a97cff5ac2aba0f803cede7125edcdd14807bc6f692a8251ae574';
const R = 'f271e55d57c533b6cb1957ff835d80e91a5ed03f3fac673b1ad6c7f79057ae02';

test('#3276 the placed record keeps a cancel (and sells) the tab already holds for that order', () => {
  const recordOfWith = pageFunction(PAGE, ['ARENACLIENT', 'readPicks', 'named', 'chosen', 'window', 'sessionKeyPkcs8'],
    [between('const keptOrderOf = ', 'const t0 = performance.now();')], 'return recordOf;');
  const ARENACLIENT = { pickRecord: (x) => ({ ...x }) };
  const named = { roundIdHex: R, round: {}, nodes: [] };
  const chosen = { pick: 0, limitPrice: 10000n, orderExpiryMs: 0, orderIndex: 3, confirmed: false };
  const kept = [{ roundIdHex: R, entryIdHex: E, order: { state: 'submitted', cancelled: true, sells: [{ id: 's1' }] } }];
  const placed = recordOfWith(ARENACLIENT, () => kept, named, chosen, {}, 'k8')(E, 'placed');
  assert.equal(placed.order.state, 'placed');
  assert.equal(placed.order.cancelled, true, 'the cancel tapped while placing is lost');
  assert.deepEqual(placed.order.sells, [{ id: 's1' }]);
  // an order nothing was done to: as before
  const fresh = recordOfWith(ARENACLIENT, () => [], named, chosen, {}, 'k8')(E, 'placed');
  assert.equal(fresh.order.cancelled, undefined);
  assert.equal(fresh.order.sells, undefined);
});

test('#3276 a seat answering that the cancel is already in a batch counts as cancelled, any other refusal does not', () => {
  const doneOf = pageFunction(PAGE, [], [between('const cancelTaken = ', 'const seats = await Promise.all(')], 'return cancelTaken;')();
  assert.equal(doneOf({ status: 202, why: '' }), true);
  assert.equal(doneOf({ status: 409, why: 'that cancel is already carried by batch 3590670430' }), true);
  assert.equal(doneOf({ status: 409, why: 'the market closed at 2026-11-22T08:15:00.000Z: no cancel after it' }), false);
  assert.equal(doneOf({ status: 0, why: 'Failed to fetch' }), false);
});
