// kanban #3038: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit settle r3-1: GET /lock-settlement?round=<id> is public and unthrottled. For a round that takes any federation with an ACCEPTED
// federation row, server.js awaits settlements.fedSummary(rid, { moved: true }), and fedSummary runs planOf(rid) - the whole plan rebuilt
// from the store (entries, finality of every run, locks, fee locks, gifts, each federation's fee rule, federationPlans) - on EVERY read.
// #2737 gave summaryOf (one-federation rounds, GET /settled) a kept summary and a kept miss; fedSummary has neither.
// The safe behaviour: a settled any-federation round's moves are not rebuilt from the store on every public read.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LockSettlement } from '../src/settlement.js';
import * as curve from '../src/curve.js';

const RID = new Uint8Array(32).fill(0x6a);
const FED = 'ab'.repeat(32);

test('GET /lock-settlement: an any-federation round settled here is not rebuilt whole on every public read', async () => {
  const round = {
    get: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [{ roundId: RID, federation: FED, state: 'ACCEPTED', txid: 'cd'.repeat(32) }],
  };
  const s = new LockSettlement(round, { curve, random: () => new Uint8Array(32), dkg: {}, port: { settle: async () => ({}) } });
  let rebuilt = 0;
  s.planOf = async () => {
    rebuilt++;
    return { ok: true, anyFed: true, split: { settlements: [{ federation: FED, payouts: [{ kind: 'qualifier', payoutPk: new Uint8Array(33).fill(2), msat: 1000n }] }] } };
  };
  // a stranger's GET /lock-settlement?round=<id>, 50 times
  for (let i = 0; i < 50; i++) {
    const rows = await s.fedSummary(RID, { moved: true });
    assert.equal(rows.length, 1);
  }
  assert.ok(rebuilt <= 1, `the round's whole plan was rebuilt ${rebuilt} times for 50 public GET /lock-settlement reads`);
});
