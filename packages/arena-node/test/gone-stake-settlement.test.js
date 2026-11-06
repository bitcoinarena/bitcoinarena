// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SETTLEMENT CLAIMS ONLY THE LOCKS THE FEDERATION STILL HOLDS (RULED 2026-11-06, kanban #1146 A). Measured 2026-11-06 on s29b, round 6c538afe: five seats
// forfeited the loser's stake before the settlement (offence (b)), and every build named that lock - "the guardians hold no Arena lock at ..." - so the
// round never closed and the winner was never paid. Now a build that names a lock the guardians do not hold makes the next plan read the losers' locks at
// the federation, and a gone one's entry is read as refunded: F′, the same table code with that stake out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { DELIVERED, FAILED, computePayoutTable, withGoneStakes } from '../../arena-protocol/src/payout.js';
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

function seat({ goneAt = new Set() } = {}) {
  const asked = [];
  const round = new Round(openStore(':memory:'));
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
    status: async (o) => { const at = `${toHex(o.txid)}:${String(o.outIdx)}`; asked.push(at); return { blockCount: 500, stored: goneAt.has(at) ? null : { contractId: 'cd'.repeat(32), blocksLeft: 100 } }; },
  };
  const ls = new LockSettlement(round, { curve, port, dkg: { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) },
    stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, winnings: { sendsFor: () => new Map() } });
  ls.entriesOnRecord = () => ({ ok: true, entries: [W, L1, L2] });
  return { ls, asked };
}

const claimed = (plan) => plan.claims.filter((c) => c.kind !== 'fee').map((c) => `${toHex(c.outpoint.txid)}:${String(c.outpoint.outIdx)}`).sort();

test('every loser\'s lock held: F, both losers claimed, and the federation is not asked', async () => {
  const { ls, asked } = seat();
  const got = await ls.planOf(RID);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(claimed(got.plan), [outpointOf(L1), outpointOf(L2)].sort());
  assert.equal(got.plan.payouts.find((p) => toHex(p.pubkey) === toHex(W.pubkey)).msat, 2n * STAKE);
  assert.equal(asked.length, 0, 'a round whose locks stand costs no federation read');
});

test('a loser\'s lock forfeited before the settlement: the build names it, the next plan is F′ - the other loser claimed, the winner paid its stake', async () => {
  const { ls, asked } = seat({ goneAt: new Set([outpointOf(L1)]) });
  // the plan before: F, and the build refuses the gone lock by name (s29b, round 6c538afe)
  const before = await ls.planOf(RID);
  assert.deepEqual(claimed(before.plan), [outpointOf(L1), outpointOf(L2)].sort());
  await assert.rejects(ls.message(RID), /hold no lock/);
  // the next plan reads the losers' locks and leaves the gone one out
  const after = await ls.planOf(RID);
  assert.equal(after.ok, true, after.why);
  assert.deepEqual(claimed(after.plan), [outpointOf(L2)]);
  assert.equal(after.plan.payouts.length, 1);
  assert.equal(after.plan.payouts[0].msat, STAKE, 'the winner is paid the one loser\'s stake the federation still holds');
  assert.ok(asked.includes(outpointOf(L1)));
  // the acked rows are F′'s: the gone entry has no row (a claimed lock with no row is a false table), the winner's row is F′'s
  const rows = new Map(after.ackRows.map((r) => [toHex(r.entryId), r]));
  assert.equal(rows.has(toHex(L1.entryId)), false);
  const fPrime = computePayoutTable({ roundId: RID, entries: withGoneStakes([W, L1, L2], new Set([toHex(L1.pubkey)])), minScore: 1 });
  assert.equal(rows.get(toHex(W.entryId)).amountMsat, fPrime.table[fPrime.activated.findIndex((e) => toHex(e.pubkey) === toHex(W.pubkey))].amountMsat);
  assert.equal(rows.get(toHex(W.entryId)).amountMsat, 2n * STAKE);
  // and the message builds now
  const m = await ls.message(RID);
  assert.equal(m.ok, true, m.why);
});

test('a gone lock read once stays gone: the next plan does not ask the federation again', async () => {
  const { ls, asked } = seat({ goneAt: new Set([outpointOf(L1)]) });
  await assert.rejects(ls.message(RID));
  await ls.planOf(RID);
  const n = asked.filter((a) => a === outpointOf(L1)).length;
  const again = await ls.planOf(RID);
  assert.deepEqual(claimed(again.plan), [outpointOf(L2)]);
  assert.equal(asked.filter((a) => a === outpointOf(L1)).length, n);
});
