// A SETTLEMENT RECOVERED AFTER A RESTART INDEXES ITS DONATION-KEY OUTPUTS (kanban #152, the owner 2026-10-07). A seat restarted
// between submitting a walk-away's settlement and finding it in the federation marked it ACCEPTED ("found in the federation
// after this signer node was inside it") but indexed its donation-key payouts only from the plan kept in memory - gone with
// the restart - so the donors never saw them. LockSettlement's own settle() and indexDonationKeys over a store fake that keeps
// what is written; only the plan rebuild (planOf) and the federation's answers are stubbed, as the restart leaves them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LockSettlement, SUBMITTING, ACCEPTED } from '../src/settlement.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const CONTRACT_HEX = readFileSync(new URL('../../blwp-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
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
  const out = [], marks = new Map();
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
  };
  return { round, out, marks };
}
function seat(round, { plan = PLAN, stored = () => true } = {}) {
  const s = new LockSettlement(round, { port: { status: async (o) => ({ stored: stored(o) ? { contractId: 'c', blocksLeft: 10 } : null }), settle: async () => ({}) } });
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
