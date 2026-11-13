// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm5-find-federation 3 (state machine audit, federation; timeout - a player away for the drain):
// A PLAYER'S NOTES IN A FEDERATION THAT TURNED CLOSED WHILE HE WAS AWAY ARE NEVER MOVED OUT.
// SM-C5 (page-lock.js evacuatePlayerWallet, federations.js safeFederation, index.html ARENA_EVACUATE): a page moves the notes of every
// federation it holds out by itself - but only while that federation's record says DRAINING or CRITICAL. The drain ends by a clock
// (server.js closedOf: DRAIN_MS, 28 days, and no open round naming it), never by the players' notes being out. A player who did not open
// the page during those 28 days comes back to a record that says CLOSED ("its successor holds everything", federations.js), and every
// automatic path refuses it: safeFederation answers null, evacuatePlayerWallet answers 'not draining', ARENA_EVACUATE skips it. The
// seats stop watching it too: halts.js observe skips a CLOSED federation, so when its guardians (no longer paid, roster.js guardiansFor
// "until its record is CLOSED") stop, no halt is proven and no liquidation pays those notes.
// Invariant: a federation that takes nothing any more (CLOSED) still has every player's notes moved to a safe one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFederation } from '../src/federations.js';
import { evacuatePlayerWallet } from '../src/page-lock.js';

const OLD = '11'.repeat(32), NEW = '22'.repeat(32);
const st = (federation, status, load, extra = {}) => ({ federation, status, load, height: 160000, invite: `fed:${federation}`, ...extra });

test('#1489 sm5 federation-3: a CLOSED federation the player still holds notes in is never moved out of', async () => {
  const statuses = [st(OLD, 'CLOSED', 0.3, { successorId: NEW }), st(NEW, 'OPEN', 0.1)];
  // control: the same federation one day earlier, DRAINING - the page moves its notes into the successor
  assert.equal(safeFederation({ ...statuses[0], status: 'DRAINING' }, statuses).federation, NEW);
  // the player comes back after the drain: the record says CLOSED, the wallet still holds notes there
  const target = safeFederation(statuses[0], statuses);
  let opened = 0;
  const r = await evacuatePlayerWallet({ from: statuses[0], target: target || statuses[1], seed: new Uint8Array(32).fill(7),
    LockClient: class { constructor() { opened++; throw new Error('opened'); } }, storage: new Map(), gateways: [] }).catch((e) => ({ state: `tried: ${e.message}` }));
  console.log('  FACTS #1489 sm5 federation-3:', JSON.stringify({ target: target && target.federation, evacuate: { state: r.state, moved: String(r.moved ?? '') }, opened }));
  // THE INVARIANT: the notes of a CLOSED federation go to its OPEN successor, as a DRAINING one's do
  assert.equal(target && target.federation, NEW, 'safeFederation names no place for the notes of a CLOSED federation');
  assert.notEqual(r.state, 'not draining', 'evacuatePlayerWallet refuses to move the notes out of a CLOSED federation');
});
