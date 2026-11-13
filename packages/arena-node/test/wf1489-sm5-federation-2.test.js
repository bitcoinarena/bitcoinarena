// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm5-find-federation 2 (state machine audit, federation; timeout - a clock that moves a state the money has not left):
// A DRAINED FEDERATION'S RESERVES ARE NEVER MOVED ONCE ITS RECORD TURNS CLOSED.
// SM-D3 (reserve-move.js moveTargets, server.js `moves`): a federation's protocol reserves move to a healthy federation only while its
// record says DRAINING or CRITICAL; one that waits says why ("no healthy federation", "no reserve key"). The drain ends by a clock, not by
// the money: server.js closedOf turns the record CLOSED once DRAIN_MS (28 days) passed and no open round names it - it never asks whether
// the reserves were moved. A move that waited the whole drain (the successor's reserve key not dealt yet, no other OPEN federation with a
// key) is then dropped without a word: moveTargets skips every status but DRAINING/CRITICAL/HALTED (`continue`), so a CLOSED federation's
// unspent reserves are neither moved nor listed as waiting - when the successor's key arrives the next day, nothing moves them, ever.
// Invariant (moveTargets' own contract): a federation holding unspent reserves that takes no new money either moves or says why it waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTargets } from '../src/reserve-move.js';

const X = '11'.repeat(32), SUCC = '22'.repeat(32);
const KX = '02' + '33'.repeat(32), KS = '02' + '44'.repeat(32);

test('#1489 sm5 federation-2: reserves still unspent when the drain clock closes the record are never moved', () => {
  // DRAINING into its successor, whose reserve key is not dealt yet: the move waits, and says so
  const draining = moveTargets([
    { id: X, status: 'DRAINING', height: 160000, successor: SUCC, key: KX, unspentMsat: 40_000_000n },
    { id: SUCC, status: 'OPEN', height: 160000, successor: null, key: null, unspentMsat: 0n },
  ]);
  assert.equal(draining.moves.length, 0);
  assert.equal(draining.waiting.length, 1, 'while draining the reserves wait, said');
  // 28 days on, no round open on X: closedOf -> the record is CLOSED (the reserves were never asked); the successor's key is dealt now
  const closed = moveTargets([
    { id: X, status: 'CLOSED', height: 164032, successor: SUCC, key: KX, unspentMsat: 40_000_000n },
    { id: SUCC, status: 'OPEN', height: 164032, successor: null, key: KS, unspentMsat: 0n },
  ]);
  console.log('  FACTS #1489 sm5 federation-2:', JSON.stringify({ draining, closed }));
  // THE INVARIANT: 40,000 sat of reserves held in X either move to the successor or wait, said
  assert.ok(closed.moves.length + closed.waiting.length > 0,
    'X holds 40000 sat of unspent reserves and is CLOSED: no move, no wait - the reserves stay in a federation nobody moves out of');
});
