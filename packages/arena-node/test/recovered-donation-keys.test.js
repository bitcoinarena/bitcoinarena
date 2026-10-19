// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SETTLEMENT RECOVERED AFTER A RESTART INDEXES ITS DONATION-KEY OUTPUTS (2026-10-07). A seat restarted
// between submitting a walk-away's settlement and finding it in the federation marked it ACCEPTED ("found in the federation
// after this signer node was inside it") but indexed its donation-key payouts only from the plan kept in memory - gone with
// the restart - so the donors never saw them. LockSettlement's own settle() and indexDonationKeys over a store fake that keeps
// what is written; only the plan rebuild (planOf) and the federation's answers are stubbed, as the restart leaves them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LockSettlement, SUBMITTING, ACCEPTED } from '../src/settlement.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const RID = new Uint8Array(32).fill(0x52), TXID = 'ab'.repeat(32);
const RECOVERED = 'found in the federation after this signer node was inside it: 3 of 3 payout contract(s) stored';
const lockAt = (n) => ({ outpoint: { txid: new Uint8Array(32).fill(n), outIdx: 0n } });
// a walk-away's plan: a qualifier, then two donation-key payouts (the set's 25%)
const PLAN = { claims: [lockAt(1), lockAt(2)], payouts: [
  { kind: 'qualifier', msat: 90000n, payoutPk: new Uint8Array(32).fill(7) },
  { kind: 'donation key', msat: 3000n, payoutPk: new Uint8Array(32).fill(8), donation: { id: new Uint8Array(32).fill(0x11) } },
  { kind: 'donation key', msat: 2000n, payoutPk: new Uint8Array(32).fill(9), donation: { id: new Uint8Array(32).fill(0x12) } } ] };
const MOVES = { txid: TXID, claims: [lockAt(2), lockAt(1)].map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`), payouts: 3 };

function storeWith(rows) {
  const out = [], marks = new Map(), tries = new Map();
  const round = {
    get: () => ({ contract: fromHex(CONTRACT_HEX) }),
    lockSettlement: (rid) => rows.get(toHex(rid))?.kept || null,
    lockSettlementMoves: (rid) => rows.get(toHex(rid))?.moves || null,
    putLockSettlement: (r) => { const x = rows.get(toHex(r.roundId)); x.kept = { ...x.kept, state: r.state, why: r.why }; },
    putDonationOutputs: (r) => out.push(...r),
    lockSettlementsIn: (state) => [...rows.entries()].filter(([, x]) => x.kept.state === state).map(([k]) => fromHex(k)),
    settlementDonationOutputs: (rid) => out.filter((r) => toHex(r.roundId) === toHex(rid)).length,
    donationBackfilled: (rid) => marks.has(toHex(rid)),
    markDonationBackfilled: (rid, r) => marks.set(toHex(rid), r),
    backfillTry: (rid) => tries.get(toHex(rid)) || null,
    putBackfillTry: (rid, n, at) => tries.set(toHex(rid), { tries: n, lastMs: at }),
  };
  return { round, out, marks };
}
let clock = Date.parse('2026-10-07T12:00:00Z');
function seat(round, { plan = PLAN, stored = () => true } = {}) {
  const s = new LockSettlement(round, { now: () => clock, port: { status: async (o) => ({ stored: stored(o) ? { contractId: 'c', blocksLeft: 10 } : null }), settle: async () => ({}) } });
  s.federationSaw = async () => ({ verdict: 'in', why: '3 of 3 payout contract(s) stored' });
  s.planOf = async () => ({ ok: true, plan });
  return s;
}
const said = [];
const realLog = console.log;
test.beforeEach(() => { said.length = 0; console.log = (...a) => { said.push(a.join(' ')); }; });
test.afterEach(() => { console.log = realLog; });

test('restart between submit and recovery: the recovered settlement indexes its donation-key outputs at (txid, payout index)', async () => {
  const { round, out } = storeWith(new Map([[toHex(RID), { kept: { txid: TXID, state: SUBMITTING, message: new Uint8Array(32), signature: new Uint8Array(64) }, moves: MOVES }]]));
  const got = await seat(round).settle(RID);                 // a fresh LockSettlement: nothing built in this process
  assert.equal(got.state, ACCEPTED);
  assert.deepEqual(out.map((r) => `${toHex(r.outpoint.txid)}:${r.outpoint.outIdx}`), [`${TXID}:1`, `${TXID}:2`], 'the donation-key outputs were not indexed');
  assert.deepEqual(out.map((r) => String(r.amountMsat)), ['3000', '2000']);
});

test('a rebuilt plan that is not the signed one indexes nothing, and says so', async () => {
  const other = { ...PLAN, claims: [lockAt(1), lockAt(3)] };
  const { round, out } = storeWith(new Map([[toHex(RID), { kept: { txid: TXID, state: SUBMITTING, message: new Uint8Array(32), signature: new Uint8Array(64) }, moves: MOVES }]]));
  const got = await seat(round, { plan: other }).settle(RID);
  assert.equal(got.state, ACCEPTED, 'the federation still decides the settlement');
  assert.equal(out.length, 0, 'a plan nobody signed was indexed');
  assert.ok(said.some((l) => /donation keys not indexed/.test(l) && /signed one/.test(l)), `no log line: ${said.join(' | ')}`);
});

test('backfill: recovered settlements without donation outputs, the same match; a payout the donor already redeemed is left out; each round once', async () => {
  const R2 = new Uint8Array(32).fill(0x53), R3 = new Uint8Array(32).fill(0x54);
  const rows = new Map([
    [toHex(RID), { kept: { txid: TXID, state: ACCEPTED, why: RECOVERED }, moves: MOVES }],
    [toHex(R2), { kept: { txid: TXID, state: ACCEPTED, why: 'claimed 1 loser lock(s)' }, moves: MOVES }],     // settled in one process: indexed then
    [toHex(R3), { kept: { txid: 'cd'.repeat(32), state: ACCEPTED, why: RECOVERED }, moves: { ...MOVES, txid: 'cd'.repeat(32), payouts: 2 } }],   // mismatch
  ]);
  const { round, out, marks } = storeWith(rows);
  const s = seat(round, { stored: (o) => o.outIdx !== 2n });     // payout 2 already redeemed by the donor
  const r1 = await s.backfillDonationKeys({ paceMs: 0 });
  assert.deepEqual(out.map((r) => `${toHex(r.outpoint.txid).slice(0, 4)}:${r.outpoint.outIdx}`), ['abab:1'], 'only the still-stored donation-key output of the matched recovered round');
  assert.equal(r1.checked, 2);
  assert.equal(r1.indexed, 1);
  assert.equal(r1.mismatched, 1);
  assert.equal(r1.redeemed, 1);
  assert.equal(marks.size, 2);
  const r2 = await s.backfillDonationKeys({ paceMs: 0 });
  assert.equal(r2.checked, 0, 'a round already passed over was checked again');
  assert.equal(out.length, 1);
});

// A ROUND WHOSE PLAN COULD NOT BE REBUILT IS NOT MARKED (the completeness check, comment 717): the backfill
// marked every round it checked, so one whose run was still PROVISIONALLY_FINAL on this seat was never checked again. Only a
// definitive outcome is marked; a later pass - the next start, or the backfill's slow clock - tries the round again.
test('backfill: a recovered round not rebuildable now stays unmarked and is indexed on a later pass once it rebuilds', async () => {
  const rows = new Map([[toHex(RID), { kept: { txid: TXID, state: ACCEPTED, why: RECOVERED }, moves: MOVES }]]);
  const { round, out, marks } = storeWith(rows);
  const s = seat(round);
  s.planOf = async () => ({ ok: false, why: 'nothing is claimed while a run is not final with its window closed: f1059b98 is PROVISIONALLY_FINAL' });
  const r1 = await s.backfillDonationKeys({ paceMs: 0 });
  assert.equal(r1.checked, 1);
  assert.equal(r1.failed, 1);
  assert.equal(marks.size, 0, 'a round that could not be rebuilt was marked checked for good');
  s.planOf = async () => ({ ok: true, plan: PLAN });              // its run turned FINAL
  const r2 = await s.backfillDonationKeys({ paceMs: 0 });
  assert.equal(r2.checked, 1, 'the round was not tried again');
  assert.equal(r2.indexed, 1);
  assert.deepEqual(out.map((r) => r.outpoint.outIdx), [1n, 2n]);
  assert.equal(marks.size, 1);
});

test('backfill: a try counts only when the round\'s last counted try is 6 h old; four spaced tries mark it checked with the reason', async () => {
  const { BACKFILL_TRIES, BACKFILL_TRY_GAP_MS } = await import('../src/settlement.js');
  assert.equal(BACKFILL_TRIES, 4); assert.equal(BACKFILL_TRY_GAP_MS, 6 * 3600 * 1000);
  const rows = new Map([[toHex(RID), { kept: { txid: TXID, state: ACCEPTED, why: RECOVERED }, moves: MOVES }]]);
  const { round, out, marks } = storeWith(rows);
  const s = seat(round);
  s.planOf = async () => ({ ok: false, why: 'nothing is claimed while a run is not final with its window closed: 7c27840f is PROVISIONALLY_FINAL' });
  const H = 3600 * 1000, t0 = clock;
  const pass = async (atMs) => { clock = atMs; return s.backfillDonationKeys({ paceMs: 0 }); };
  await pass(t0);                                                     // first try: counted (1)
  assert.equal(round.backfillTry(RID).tries, 1);
  for (const h of [1, 2, 3, 5.9]) await pass(t0 + h * H);             // restarts inside 6 h: the pass runs, no try consumed
  assert.equal(round.backfillTry(RID).tries, 1, 'a restart inside 6 h consumed a try');
  assert.equal(marks.size, 0);
  await pass(t0 + 6 * H);                                             // 6 h after the last counted try: counted (2)
  assert.equal(round.backfillTry(RID).tries, 2);
  await pass(t0 + 7 * H);                                             // 1 h later: not counted
  assert.equal(round.backfillTry(RID).tries, 2);
  await pass(t0 + 12 * H);                                            // (3)
  assert.equal(marks.size, 0, 'marked before four counted tries');
  const last = await pass(t0 + 18 * H);                               // (4): marked, with the reason
  assert.equal(round.backfillTry(RID).tries, BACKFILL_TRIES);
  assert.equal(last.gaveUp, 1);
  assert.match(marks.get(toHex(RID)).why, /^not rebuilt after 4 tries: its plan was not rebuilt: nothing is claimed/);
  assert.equal((await pass(t0 + 30 * H)).checked, 0, 'asked again after it was marked');
  assert.equal(out.length, 0);
});
