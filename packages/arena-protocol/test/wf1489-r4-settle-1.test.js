// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack round 4 (settlement): A TIE FOR A PAID PLACE IS DECIDED BY THE RAW PLAYER KEY, WHICH THE PLAYER CHOOSES.
// computePayoutTable sorts qualifiers with equal score by compareBytes(a.pubkey, b.pubkey). The comment beside it says ties are
// "decided by the same rule the remainder uses" (H(round_id || pubkey)), but the code compares the bare key. The entry's player
// key is the player's own choice (no signature binds it to anything; a client mints it), so a player who grinds a key starting
// 0x00 (256 tries per leading zero byte) wins EVERY tie, in every round: the whole pool with one paying rank, the top share with
// more. Safe behaviour: a tie is decided by something the player cannot fix in advance for every round (the round-salted hash),
// so the same ground key does not win the tie in every round.
// DECIDED 2026-11-14 (kanban #1614, "Ja alle 15"): H(round_id || pubkey) from the next protocol, 29; older rounds keep the old order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computePayoutTable, FAILED, DELIVERED } from '../src/payout.js';

const rid = (i) => new Uint8Array(createHash('sha256').update(`round-${i}`).digest());
const key = (first, fill) => { const k = new Uint8Array(32).fill(fill); k[0] = first; return k; };
const entry = (pubkey, outcome, score) => ({ pubkey, stakeMsat: 100000n, feeMsat: 4000n, donationMsat: 0n, outcome, score });

test('a ground low player key does not win every tie for the paid place', () => {
  const grinder = key(0x00, 0x00); grinder[31] = 1;      // a key ground to start 0x00
  const honest = key(0x7f, 0x42);
  let grinderWon = 0;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const g = entry(grinder, DELIVERED, 100);
    const h = entry(honest, DELIVERED, 100);            // the same score: a tie
    const loser = entry(key(0x55, 0x55), FAILED, 0);
    const t = computePayoutTable({ roundId: rid(i), entries: [h, g, loser], protocolVersion: 29 });
    const pay = new Map(t.table.map((r) => [Buffer.from(r.pubkey).toString('hex'), r.amountMsat]));
    const gp = pay.get(Buffer.from(grinder).toString('hex'));
    const hp = pay.get(Buffer.from(honest).toString('hex'));
    if (gp > hp) grinderWon++;
  }
  assert.ok(grinderWon < N,
    `the player who ground a 0x00 key won the tie (and the whole loser pool) in ${grinderWon} of ${N} rounds: ties go by the raw key the player chose`);
});

test('a round below protocol 29 keeps the bare-key order it was settled by (seats agree on rounds already played)', () => {
  const grinder = key(0x00, 0x00); grinder[31] = 1;
  const honest = key(0x7f, 0x42);
  for (const v of [null, 1, 27, 28]) for (let i = 0; i < 8; i++) {
    const t = computePayoutTable({ roundId: rid(i), entries: [entry(honest, DELIVERED, 100), entry(grinder, DELIVERED, 100), entry(key(0x55, 0x55), FAILED, 0)], protocolVersion: v });
    const pay = new Map(t.table.map((r) => [Buffer.from(r.pubkey).toString('hex'), r.amountMsat]));
    assert.ok(pay.get(Buffer.from(grinder).toString('hex')) > pay.get(Buffer.from(honest).toString('hex')), `version ${v} round ${i}: the old order moved`);
  }
});
