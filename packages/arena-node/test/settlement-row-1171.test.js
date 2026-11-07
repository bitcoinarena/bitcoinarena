// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND'S SETTLEMENT ROW (kanban #1171, the 2026-11-06 state-machine audit): `accepted` was submit_transaction's pre-validation, so two askers with
// other bytes (F and F', ruling #1146) both wrote ACCEPTED and drove sends from a transaction that does not exist; a refused submit wrote REFUSED over
// the other asker's landed one; and nothing kept a txid but the last. Now one transition function (settlementRowStep), a txid history per round,
// ACCEPTED only on the guardians' word (payouts stored, claimed locks gone), REFUSED only after every txid of the round was asked, and recover()
// reads REFUSED rows too. The old source decided `state = sent.accepted ? ACCEPTED : REFUSED` and wrote it as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x61);
const CONTRACT = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2 });
const CLAIM_PK = new Uint8Array(33).fill(2);
const STAKE = 100000n;
const entry = (n, outcome, score) => ({ entryId: b32(0x10 + n), pubkey: b32(0x20 + n), stakeMsat: STAKE, feeMsat: 0n, donationMsat: 0n, outcome, score });
const W = entry(1, DELIVERED, 5), L1 = entry(2, FAILED, 0), L2 = entry(3, FAILED, 0);
const outpointOf = (e) => `${toHex(b32(0x40 + e.pubkey[0]))}:0`;

function seat({ goneAt = new Set(), round: given = null, left = new Map() } = {}) {
  const asked = [];
  const round = given || new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: CONTRACT } : null);
  const byId = new Map([W, L1, L2].map((e) => [toHex(e.entryId), e]));
  round.stakeLock = (eid) => {
    const e = byId.get(toHex(eid));
    return { outpoint: outpointOf(e), fields: { paymentImage: { kind: 'hash', bytes: '' }, amountMsat: String(STAKE), claimPk: toHex(CLAIM_PK), refundPk: toHex(Uint8Array.from([2, ...e.pubkey])), expiration: 1000 } };
  };
  const port = {
    fees: async () => ({ ppm: 0n, baseMsat: 0n }),
    settle: async ({ claims }) => {
      for (const c of claims) { const at = `${toHex(c.outpoint.txid)}:${String(c.outpoint.outIdx)}`; if (goneAt.has(at)) throw new Error(`the guardians hold no lock at ${at}`); }
      return { message: '00'.repeat(32), txid: 'ab'.repeat(32) };
    },
    status: async (o) => { const at = `${toHex(o.txid)}:${String(o.outIdx)}`; asked.push(at); return { blockCount: 500, stored: goneAt.has(at) ? null : { contractId: 'cd'.repeat(32), blocksLeft: left.has(at) ? left.get(at) : 100 } }; },
  };
  const ls = new LockSettlement(round, { curve, port, dkg: { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) },
    stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, winnings: { sendsFor: () => new Map() } });
  ls.entriesOnRecord = () => ({ ok: true, entries: [W, L1, L2] });
  return { ls, asked, round };
}


import { settlementRowStep, SUBMITTING, ACCEPTED, REFUSED } from '../src/settlement.js';

const T0 = 'a0'.repeat(32), T1 = 'b1'.repeat(32);
const m = (txid) => ({ txid, message: new Uint8Array(32).fill(1), plan: { payouts: [{}], claims: [] }, claims: [] });

test('one transition function: ACCEPTED is final and only on the guardians\' word; REFUSED only after every txid was asked', () => {
  assert.equal(settlementRowStep(null, { state: SUBMITTING }).ok, true);
  assert.equal(settlementRowStep(null, { state: ACCEPTED, verified: true }).ok, false, 'none -> ACCEPTED skips the intent');
  assert.match(settlementRowStep({ state: SUBMITTING }, { state: ACCEPTED }).why, /not on a pre-validated submit/);
  assert.equal(settlementRowStep({ state: SUBMITTING }, { state: ACCEPTED, verified: true }).ok, true);
  assert.match(settlementRowStep({ state: SUBMITTING }, { state: REFUSED }).why, /every txid/);
  assert.equal(settlementRowStep({ state: REFUSED }, { state: SUBMITTING }).ok, true, 'signed again after a refusal');
  for (const to of [SUBMITTING, REFUSED, ACCEPTED]) assert.match(settlementRowStep({ state: ACCEPTED }, { state: to, verified: true, checkedAll: true }).why, /final/);
});

test('a pre-validated submit (accepted, nothing stored yet) stays SUBMITTING - not ACCEPTED', async () => {
  const { ls, round } = seat();
  ls.confirmSoon = () => {};
  round.putSettlementTxid({ roundId: RID, txid: T1, message: new Uint8Array(32), claims: [outpointOf(L1)], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'about to submit' });
  const state = await ls.recordSubmit(RID, m(T1), new Uint8Array(64), { accepted: true, payoutsStored: null, locksAfter: null }, 'claimed');
  assert.equal(state, SUBMITTING);
  assert.equal(round.lockSettlement(RID).state, SUBMITTING);
  // with the guardians' word it is ACCEPTED
  const got = await ls.recordSubmit(RID, m(T1), new Uint8Array(64), { accepted: true, payoutsStored: [{ id: 'p' }], locksAfter: [null] }, 'claimed');
  assert.equal(got, ACCEPTED);
});

test('a refused submit whose round already landed on another txid (the other asker\'s) is ACCEPTED on that txid, not REFUSED', async () => {
  // T0 (F, the other asker's) landed: its claimed lock gone, its payout stored; T1 (F') is this seat's, refused
  const { ls, round } = seat({ goneAt: new Set([outpointOf(L1)]) });
  ls.confirmSoon = () => {};
  round.putSettlementTxid({ roundId: RID, txid: T0, message: new Uint8Array(32).fill(7), signature: new Uint8Array(64).fill(7), claims: [outpointOf(L1)], payouts: 1 });
  round.putSettlementTxid({ roundId: RID, txid: T1, message: new Uint8Array(32), claims: [outpointOf(L2)], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'about to submit' });
  const state = await ls.recordSubmit(RID, m(T1), new Uint8Array(64), { accepted: false, error: 'already spent' }, 'claimed');
  assert.equal(state, ACCEPTED);
  const row = round.lockSettlement(RID);
  assert.deepEqual([row.state, row.txid], [ACCEPTED, T0]);
});

test('refused, and no txid of the round in: REFUSED; recover() then finds a landed one and makes the row ACCEPTED', async () => {
  const goneAt = new Set();
  const { ls, round } = seat({ goneAt });
  ls.confirmSoon = () => {};
  round.putSettlementTxid({ roundId: RID, txid: T1, message: new Uint8Array(32), claims: [outpointOf(L1)], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'about to submit' });
  // T1's claimed lock still held, its payout not stored: out
  const origStatus = ls.port.status;
  ls.port.status = async (o) => { const at = `${toHex(o.txid)}:${String(o.outIdx)}`; return at.startsWith(T1) ? { blockCount: 500, stored: null } : origStatus(o); };
  assert.equal(await ls.recordSubmit(RID, m(T1), new Uint8Array(64), { accepted: false, error: 'refused' }, 'claimed'), REFUSED);
  // later the other asker's T0 is handed and lands; a restarted seat asks every txid of its REFUSED rows
  round.putSettlementTxid({ roundId: RID, txid: T0, message: new Uint8Array(32).fill(7), signature: new Uint8Array(64).fill(7), claims: [outpointOf(L2)], payouts: 1 });
  goneAt.add(outpointOf(L2));
  const out = await ls.recover();
  assert.deepEqual(out.filter((x) => x.state === ACCEPTED).map((x) => x.round), [toHex(RID)]);
  assert.deepEqual([round.lockSettlement(RID).state, round.lockSettlement(RID).txid], [ACCEPTED, T0]);
});

// KANBAN #1258 (audit 3 #1210 FIXES-18, the 1.9 port of 2.0's #1170 check): a row SUBMITTING on this seat's own txid asked only that txid on each pass.
// Rebuilt onto T1 while the other asker's T0 was landing, it read T1 "mixed" for good and stayed SUBMITTING - the round never settled here, a restart
// did not help. Now the kept-SUBMITTING path asks every txid of the round's history and goes ACCEPTED on the one that is in.
test('#1258 a row SUBMITTING on its own txid is ACCEPTED on the round\'s other txid that landed (the other asker\'s), not left SUBMITTING', async () => {
  // T0 (handed, the other asker's) landed: its claimed lock gone, its payout stored; T1 (this seat's rebuild) claims a lock still held - mixed
  const { ls, round } = seat({ goneAt: new Set([outpointOf(L1)]) });
  ls.confirmSoon = () => {};
  ls.sendWinnings = async () => ({ ok: true, sent: [] });
  round.putSettlementTxid({ roundId: RID, txid: T0, message: new Uint8Array(32).fill(7), signature: new Uint8Array(64).fill(7), claims: [outpointOf(L1)], payouts: 1 });
  round.putSettlementTxid({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), claims: [outpointOf(L2)], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'rebuilt onto T1' });
  const own = await ls.federationSaw(RID, { txid: T1 });
  const got = await ls.settle(RID);
  const row = round.lockSettlement(RID);
  const again = await ls.settle(RID);
  console.log('  FACTS #1258:', JSON.stringify({ ownTxid: own.verdict, answer: [got.state, (got.txid || '').slice(0, 4)], row: [row.state, row.txid.slice(0, 4)], second: [again.state || (again.kept ? 'kept' : null)] }));
  assert.equal(own.verdict, 'mixed', 'the fixture: the row\'s own txid reads mixed');
  assert.deepEqual([row.state, row.txid], [ACCEPTED, T0]);
  assert.equal(got.state, ACCEPTED);
  // variant: no txid of the round in - still SUBMITTING on its own txid, nothing invented
  const b = seat();
  b.ls.confirmSoon = () => {};
  b.round.putSettlementTxid({ roundId: RID, txid: T0, message: new Uint8Array(32).fill(7), signature: new Uint8Array(64).fill(7), claims: [outpointOf(L1)], payouts: 1 });
  b.round.putSettlementTxid({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), claims: [outpointOf(L2)], payouts: 1 });
  b.round.putLockSettlement({ roundId: RID, txid: T1, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'rebuilt onto T1' });
  await b.ls.settle(RID).catch(() => null);
  assert.deepEqual([b.round.lockSettlement(RID).state, b.round.lockSettlement(RID).txid], [SUBMITTING, T1]);
});
