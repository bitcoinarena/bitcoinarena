// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LOCK IS CLAIMED OR FORFEITED AT A SEAT, NEVER BOTH (kanban #1184, the 2026-11-06 state-machine audit). The forfeit's ENTRY_VOID and qualifier paths
// never read this seat's own settlement: a seat that committed to a claim of a loser's lock (its moves kept, its ack or share given, a combined
// settlement taken) and then learned ENTRY_VOID for that entry signed a forfeit of the same lock - two valid spends, the faster wins. Now one enum
// (forfeit.js LOCK_FATE: CLAIMING | RETURNING) with one transition function, written before the ack, share or forfeit leaves the seat.
// The old source: the forfeit of the claimed lock is signable (ok) after ENTRY_VOID, and a settlement claiming a lock this seat forfeited is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, SUBMITTING } from '../src/settlement.js';
import { Forfeit } from '../src/forfeit.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x71);
const CONTRACT = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2 });
// THE ROUND'S CLAIM KEY, held whole here so a test can make a valid forfeit and a valid settlement signature
const CLAIM_SK = b32(0x33);
const CLAIM_PK = Uint8Array.from([2, ...schnorr.getPublicKey(CLAIM_SK)]);
const LOSER = b32(0x12);
const OUTPOINT = `${toHex(b32(0x52))}:0`;
const CONTRACT_ID = 'cd'.repeat(32);
const TXID = 'ab'.repeat(32);
const SETTLE_MSG = b32(0x0a);

function seat() {
  const round = new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: CONTRACT } : null);
  const voids = new Set();
  round.entryVoid = (eid) => (voids.has(toHex(eid)) ? { learned: 'own', why: 'outage' } : null);
  round.stakeLock = (eid) => (toHex(eid) === toHex(LOSER) ? { outpoint: OUTPOINT, contractId: CONTRACT_ID,
    fields: { paymentImage: { kind: 'hash', bytes: '' }, amountMsat: '100000', claimPk: toHex(CLAIM_PK), refundPk: '02' + '11'.repeat(32), expiration: 1000 } } : null);
  const dkg = { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) };
  const port = { contractId: async () => CONTRACT_ID };
  const forfeit = new Forfeit(round, { dkg, port, curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)) });
  const ls = new LockSettlement(round, { curve, port, dkg, stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) } });
  // the settlement this seat rebuilds: it claims the loser's lock
  const m = { ok: true, txid: TXID, message: SETTLE_MSG, claimPk: CLAIM_PK, named: false, contract: { protocolVersion: 2 },
    claims: [{ outpoint: { txid: b32(0x52), outIdx: 0n }, pubkey: b32(0x22) }], plan: { payouts: [{}], stakeShares: [] } };
  ls.message = async () => m;
  ls.confirmSoon = () => {};
  return { round, forfeit, ls, m, voids };
}

test('one transition function: none -> CLAIMING | RETURNING, either final, never the other', async () => {
  const { LOCK_FATE, lockFateStep } = await import('../src/forfeit.js');
  assert.ok(LOCK_FATE, 'forfeit.js names the fates of a lock');
  assert.equal(lockFateStep(null, LOCK_FATE.CLAIMING).ok, true);
  assert.equal(lockFateStep(null, LOCK_FATE.RETURNING).ok, true);
  assert.equal(lockFateStep(LOCK_FATE.CLAIMING, LOCK_FATE.CLAIMING).ok, true, 'a second settlement claiming the same lock is the same fate');
  assert.match(lockFateStep(LOCK_FATE.CLAIMING, LOCK_FATE.RETURNING).why, /signs no forfeit/);
  assert.match(lockFateStep(LOCK_FATE.RETURNING, LOCK_FATE.CLAIMING).why, /signs no claim/);
});

test('a seat whose settlement claims a loser\'s lock, then learns ENTRY_VOID for that entry, signs no forfeit of the lock', async () => {
  const { forfeit, ls, m, voids } = seat();
  // this seat keeps what its signed settlement moves (as #settleOnce does before the submit)
  ls.keepMoves(RID, m);
  // then ENTRY_VOID is recorded here for the same entry (its proof learned late)
  voids.add(toHex(LOSER));
  const got = await forfeit.message(RID, LOSER);
  assert.equal(got.ok, false, 'the old source signs this forfeit: two valid spends of one lock');
  assert.match(got.why, /claims that lock/);
});

test('a combined settlement handed over that claims a lock this seat already forfeited is not taken', async () => {
  const { round, forfeit, ls, voids } = seat();
  voids.add(toHex(LOSER));
  // the forfeit of the lock back to its player, combined elsewhere and handed here: kept, RETURNING
  const fm = await forfeit.message(RID, LOSER);
  assert.equal(fm.ok, true, fm.why);
  const kept = await forfeit.take(RID, LOSER, schnorr.sign(fm.message, CLAIM_SK));
  assert.equal(kept.ok, true, kept.why);
  // then a settlement claiming that lock is handed over: its signature verifies under the claim key
  const got = await ls.take(RID, schnorr.sign(SETTLE_MSG, CLAIM_SK));
  assert.equal(got.ok, false, 'the old source takes it and holds the row SUBMITTING');
  assert.match(got.why, /signs no claim/);
  assert.equal(round.lockSettlement(RID), null);
});

test('a combined settlement taken first: the lock is CLAIMING, and an ENTRY_VOID forfeit share or take is refused', async () => {
  const { round, forfeit, ls, voids } = seat();
  const got = await ls.take(RID, schnorr.sign(SETTLE_MSG, CLAIM_SK));
  assert.equal(got.ok, true, got.why);
  assert.equal(round.lockSettlement(RID).state, SUBMITTING);
  assert.equal(round.lockFate(OUTPOINT).state, 'CLAIMING');
  voids.add(toHex(LOSER));
  assert.equal((await forfeit.commit(RID, LOSER)).ok, false);
  // a forfeit combined by the other seats is not kept here either
  const msg = fromHex(CONTRACT_ID);
  const t = await forfeit.take(RID, LOSER, schnorr.sign(msg, CLAIM_SK));
  assert.equal(t.ok, false);
  assert.equal(round.forfeit(LOSER), null);
});
