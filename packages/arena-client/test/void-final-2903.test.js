// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2903 (feedback #147): a VOID (past its deadline) or DISPUTED order is decided - its line is final, so a client's Past orders
// row stops reading "pending" (the Up/Down client's HISTORY.isFinal reads `final`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketLines } from '../src/market.js';

test('a VOID past its deadline and a DISPUTED order are final', () => {
  const market = { name: 'btc-updown-15m', outcomes: ['Up', 'Down'], threshold: 2, attestors: [1, 2, 3], terms: { resolveAfterCloseMs: 0, deadlineAfterResolveMs: 600000 } };
  const now = 2_000_000_000_000, close = now - 3_600_000;
  const pick = (r, e) => ({ roundIdHex: r.repeat(64), entryIdHex: e.repeat(64), market, pick: 0, stakeMsat: 100000n, entryCloseMs: close });
  const lines = marketLines({ picks: [pick('a', '1'), pick('b', '2'), { ...pick('c', '3'), entryCloseMs: now - 60_000 }],
    outcomes: new Map([['a'.repeat(64), { state: 'VOID', why: 'no attestation by its deadline' }], ['b'.repeat(64), { state: 'DISPUTED' }], ['c'.repeat(64), { state: 'VOID' }]]), nowMs: now });
  assert.deepEqual(lines.map((l) => [l.state, l.final === true]), [['void', true], ['disputed', true], ['unverified', false]]);
});
