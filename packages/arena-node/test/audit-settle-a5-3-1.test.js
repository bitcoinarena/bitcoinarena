// kanban #3312: the card's test (audit settle a5-3-1)
// Audit settle r3 (a5-3-1): gap in the #3038 fix. fedSummary keeps the any-federation split of at most FED_SUMMARY_MOST (512) rounds,
// oldest first out. A stranger who reads GET /lock-settlement?round=<id> over 513 settled any-federation rounds in turn evicts each
// round's kept split just before it is read again, so every public read rebuilds the whole plan (planOf) once more - the cost #3038
// removed, back for any seat that holds more settled paid rounds than the cap (every paid round takes any federation from 2026.0.3).
// The safe behaviour: a settled round's split, once built, is not rebuilt on later public reads (at most one rebuild per round).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LockSettlement, FED_SUMMARY_MOST } from '../src/settlement.js';
import * as curve from '../src/curve.js';

const FED = 'ab'.repeat(32);
const ridOf = (i) => { const r = new Uint8Array(32); r[0] = 0x6a; r[28] = (i >>> 24) & 255; r[29] = (i >>> 16) & 255; r[30] = (i >>> 8) & 255; r[31] = i & 255; return r; };

test('GET /lock-settlement over FED_SUMMARY_MOST + 1 settled any-federation rounds: each round\'s plan is rebuilt once, not on every read', async () => {
  const round = {
    get: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: (rid) => [{ roundId: rid, federation: FED, state: 'ACCEPTED', txid: 'cd'.repeat(32) }],
  };
  const s = new LockSettlement(round, { curve, random: () => new Uint8Array(32), dkg: {}, port: { settle: async () => ({}) } });
  let rebuilt = 0;
  s.planOf = async () => {
    rebuilt++;
    return { ok: true, anyFed: true, split: { settlements: [{ federation: FED, payouts: [{ kind: 'qualifier', payoutPk: new Uint8Array(33).fill(2), msat: 1000n }] }] } };
  };
  const rounds = FED_SUMMARY_MOST + 1;
  const passes = 3;
  // a stranger's GET /lock-settlement?round=<id>, round after round, three passes
  for (let p = 0; p < passes; p++) for (let i = 0; i < rounds; i++) {
    const rows = await s.fedSummary(ridOf(i), { moved: true });
    assert.equal(rows.length, 1);
  }
  assert.ok(rebuilt <= rounds,
    `${rebuilt} whole-plan rebuilds for ${passes * rounds} public reads of ${rounds} settled rounds (at most ${rounds}: once each)`);
});
