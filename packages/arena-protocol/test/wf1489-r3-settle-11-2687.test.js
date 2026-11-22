// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack round 3 (settlement), a way around the #1614 fix: FROM PROTOCOL 29 A TIE GOES BY H(round_id || pubkey),
// BUT THE ROUND ID IS PUBLIC BEFORE ANY ENTRY IS MADE (the entry contract signs it), so a client that mints its key AFTER it
// has seen the round grinds 32 keys and keeps the one whose salted hash sorts first. The salt only stops a key ground ONCE for
// every round; it does not stop a key ground for THIS round. With one paying rank (four qualifiers or fewer) the tie is the
// whole loser pool. Safe behaviour: the tie order is decided by something the player cannot know when its key is fixed (for
// example the round's beacon / a block after the entry close), so per-round grinding wins no more than its fair share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { computePayoutTable, remainderOrder, FAILED, DELIVERED } from '../src/payout.js';

const rid = (i) => new Uint8Array(createHash('sha256').update(`r3-settle-11-round-${i}`).digest());
const entry = (pubkey, outcome, score) => ({ pubkey, stakeMsat: 100000n, feeMsat: 4000n, donationMsat: 0n, outcome, score });

// kanban #2687 (ruling #2776): from protocol 31 a tie at a paid place is split evenly - run at 31, the grinder never gets more than the honest player
test('a key minted after the round id is known does not win every tie for the paid place (protocol 31)', () => {
  const N = 24;
  let grinderWon = 0;
  for (let i = 0; i < N; i++) {
    const roundId = rid(i);
    // the attacker's client: 32 candidate keys, keep the one the round's salted tie order puts first
    const candidates = Array.from({ length: 32 }, () => ({ pubkey: new Uint8Array(randomBytes(32)) }));
    const grinder = remainderOrder(roundId, candidates)[0].pubkey;
    const honest = new Uint8Array(randomBytes(32));
    const g = entry(grinder, DELIVERED, 100);
    const h = entry(honest, DELIVERED, 100);             // the same score: a tie for the one paying rank
    const loser = entry(new Uint8Array(randomBytes(32)), FAILED, 0);
    const t = computePayoutTable({ roundId, entries: [h, g, loser], protocolVersion: 31 });
    const pay = new Map(t.table.map((r) => [Buffer.from(r.pubkey).toString('hex'), r.amountMsat]));
    if (pay.get(Buffer.from(grinder).toString('hex')) > pay.get(Buffer.from(honest).toString('hex'))) grinderWon++;
  }
  console.log(`  grinder (32 keys per round) won the tie and the whole loser pool in ${grinderWon} of ${N} rounds`);
  assert.ok(grinderWon <= 18,
    `a key ground for this round's public id won the tie in ${grinderWon} of ${N} rounds: H(round_id || pubkey) is known before the key is fixed`);
});

test('#2687: protocol 31 splits a paid tie evenly, the odd msat to the reserves; protocol 29 keeps #1614\'s order', () => {
  const roundId = rid(99);
  const a = entry(new Uint8Array(32).fill(1), DELIVERED, 100), b = entry(new Uint8Array(32).fill(2), DELIVERED, 100), c = entry(new Uint8Array(32).fill(3), DELIVERED, 100);
  const lose = entry(new Uint8Array(32).fill(7), FAILED, 0);
  lose.stakeMsat = 100001n;   // a pool of 96001 msat over three tied: 32000 each, 1 msat odd
  const t31 = computePayoutTable({ roundId, entries: [a, b, c, lose], protocolVersion: 31 });
  const won = t31.table.slice(0, 3).map((r) => r.amountMsat - 96000n);
  assert.deepEqual(won, [32000n, 32000n, 32000n]);
  assert.equal(t31.reserveMsat, 1n);
  const t29 = computePayoutTable({ roundId, entries: [a, b, c, lose], protocolVersion: 29 });
  assert.equal(t29.reserveMsat, 0n);
  assert.notDeepEqual(t29.table.slice(0, 3).map((r) => r.amountMsat), t31.table.slice(0, 3).map((r) => r.amountMsat), 'below 31 the tie keeps its order');
});

test('#2687: the lock actions of a protocol-31 tie hand the pool out exactly, the odd msat counted to the reserves', async () => {
  const { lockActions } = await import('../src/lock-action.js');
  const roundId = rid(100);
  const a = entry(new Uint8Array(32).fill(1), DELIVERED, 100), b = entry(new Uint8Array(32).fill(2), DELIVERED, 100), c = entry(new Uint8Array(32).fill(3), DELIVERED, 100);
  const lose = entry(new Uint8Array(32).fill(7), FAILED, 0); lose.stakeMsat = 100001n;
  const h = lockActions({ roundId, entries: [a, b, c, lose], protocolVersion: 31 });
  assert.equal(h.poolMsat, 96001n);
  assert.equal(h.sharesMsat, 96000n);
  assert.equal(h.reserveMsat, 1n);
});
