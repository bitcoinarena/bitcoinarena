// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation), round 11: THE AUTOMATIC EVACUATION PUTS NEW MONEY INTO A FEDERATION THAT TAKES NONE.
// A federation turns DRAINING (or CRITICAL) with no OPEN successor named: the page's ARENA_EVACUATE (index.html) asks safeFederation for a
// target and evacuatePlayerWallet -> migrateFromDraining makes an LNv2 receive invoice in it (to.receive) and pays it. safeFederation's
// fallback is pickFederation over every OPEN, known federation - it never asks takesDeposits / takesNewRounds (kanban #807: "the last word on
// where new money goes ... no invoice is made for a federation that takes no new deposits", enforced only in depositOffer /
// walletDepositOffer). So with B2 (4dc88be7..., noNewDeposits + noNewRounds) at the lowest load, a draining A's notes are moved - fees paid
// on every chunk - into B2, where no round opens: the player's whole balance lands where it cannot play, and must be moved again.
// Safe behaviour: the evacuation target is a federation that takes deposits (the named successor aside); none -> the notes wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFederation, depositFederation } from '../src/federations.js';
import { takesDeposits, takesNewRounds } from '../../arena-protocol/src/known-federations.js';

const A = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e';    // Arena testnet4
const B = 'b18947f085d40df3ce4bc8ac64df9c45256223e88fe7fdbdebf3eae13fb10b73';    // Arena testnet4 B
const B2 = '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98';   // B2: noNewDeposits, noNewRounds (kanban #807)
const st = (federation, status, load, more = {}) => ({ federation, status, load, height: 160000, invite: `fed1-invite-${federation.slice(0, 6)}`, ...more });

test('wf1489-sm1-federation-22: a draining federation\'s notes are never evacuated into a federation that takes no new deposits', () => {
  assert.equal(takesDeposits(B2), false); assert.equal(takesNewRounds(B2), false);
  const statuses = [st(A, 'DRAINING', 0.8), st(B, 'OPEN', 0.6), st(B2, 'OPEN', 0.05)];
  // a deposit never goes to B2 (the #807 rule) ...
  assert.equal(depositFederation({ lobbyInvite: statuses[0].invite, statuses, held: [] }).federation, B);
  // ... but the page's evacuation target, read as ARENA_EVACUATE reads it, does
  const target = safeFederation({ ...statuses[0], federation: A }, statuses, { known: () => true });
  assert.ok(target, 'an OPEN federation that takes deposits exists');
  assert.ok(takesDeposits(target.federation) && takesNewRounds(target.federation),
    `A's notes are moved into ${String(target.federation).slice(0, 8)}, which takes no new deposits and opens no round (an invoice is made there by migrateFromDraining)`);
});
