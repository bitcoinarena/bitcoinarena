// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm1 page-9 (state-machine audit on 1a7276a5e): A REFUND ROW WAITING FOR ITS NOTES (#3783) IS WRITTEN BY ANOTHER KEPT PHRASE'S WALLET.
// arena.credit.pending.<fed16>.<row> is keyed by federation only; landPendingCredits asks the wallet of whichever record the pass collects next
// (the current phrase's newest round, right after an older record of a kept phrase) whether the txid still issues notes. That wallet never
// made the refund, so it answers no, and the '+X sat' row is written while the kept phrase's notes are still being issued (#3783 again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// game-app constants as fixed bytes (this branch has no game-app package)
const TRUCK_V3_CONFIG_HASH = b32(0x13), BLOCK_TICKS = 10800, CORE_HASH = b32(0x14), NEXTBLOCK_GAME_ID = b32(0x15);
const now = BigInt(Date.now());
// settlementSlots 2: the settlement's threshold is 2 of 2
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x51);
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
const mine = toHex(refundKeyOf(player.pubkey));
const CLAIM_SECRET = b32(0x77);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SECRET)]);
const STORED = 'c0'.repeat(32);   // the contract id the guardians hold at the lock's outpoint
const fields = { paymentImage: { kind: 'point', bytes: Uint8Array.from([0x03, ...b32(0x5e)]) }, amountMsat: 980000n, claimPk: CLAIM_PK, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
const memStorage = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const REFUND_TX = '9a'.repeat(32);

// the player wallet: the refund is accepted at once, its notes are issued later (`land()`), as the stock mint's output machines issue them
const walletOf = (start) => {
  const w = { bal: start, issuing: [], refunds: 0 };
  w.land = () => { for (const i of w.issuing) w.bal += i.msat; w.issuing = []; };
  w.client = {
    async lockStatus() { return JSON.stringify({ block_count: 500, stored: w.refunds ? null : { contract_id: STORED, blocks_left: 0 } }); },
    async balanceMsat() { return String(w.bal); },
    async issuingDetail() { return JSON.stringify(w.issuing.map((i) => ({ txid: i.txid, msat: Number(i.msat), accepted: true }))); },
    async refund() { const before = w.bal; w.refunds += 1; w.issuing.push({ txid: REFUND_TX, msat: fields.amountMsat });
      return JSON.stringify({ accepted: true, txid: REFUND_TX, amount_msat: Number(fields.amountMsat), balance_before: Number(before), balance_after: Number(w.bal) }); },
  };
  return w;
};
const lockSeen = { outpoint: { txid: fromHex('cd'.repeat(32)), outIdx: 0 }, fields };
const ask = (w, storage) => ({ round, roundId: rid, invite: 'fed11x', seed, curve: pageCurve, storage, nodes: [], fetcher: async () => new Response('no', { status: 404 }),
  LockClient: { join: async () => w.client, lockAllowanceMsat: () => '0' } });
const look = { payout: { state: 'none' }, stake: { state: 'expired', locks: [lockSeen] }, payoutMsat: 0n, stakeMsat: 0n, refundMsat: fields.amountMsat, owedMsat: fields.amountMsat, inTabMsat: 0n, final: false };
const rowsOf = (storage) => PL.ledgerRows(storage, round.federationId).map((r) => [r.kind, r.msat]);


test('sm1 page-9: a kept phrase\'s refund row still waits for its notes after a pass collects the current phrase\'s round of the same federation', async () => {
  const storage = memStorage();
  const kept = walletOf(93000n);                 // the kept phrase's wallet: its refund is accepted, its notes not yet issued
  const co = await PL.collectIntoPlayerWallet({ look, ...ask(kept, storage) });
  assert.equal(co.collected, true);
  assert.deepEqual(rowsOf(storage), [], 'no row while the notes are issued (the #3783 fix)');
  // the same pass goes on to the newest record: the current phrase (another seed), the same federation, nothing owed
  const seedB = b32(0x52);
  const current = walletOf(5000n);
  const askB = { ...ask(current, storage), seed: seedB };
  await PL.collectIntoPlayerWallet({ look: { payout: { state: 'none' }, stake: { state: 'none' }, payoutMsat: 0n, stakeMsat: 0n, refundMsat: 0n, owedMsat: 0n, inTabMsat: 0n, final: true }, ...askB });
  const at = { rows: rowsOf(storage), keptWallet: String(kept.bal), keptStillIssuing: kept.issuing.length };
  console.log('  FACTS sm1-page-9:', JSON.stringify(at));
  assert.equal(kept.issuing.length, 1, 'the kept phrase\'s notes are still being issued');
  assert.deepEqual(at.rows, [], `a "+${fields.amountMsat} msat" row is written while its notes are not in any wallet (rows ${JSON.stringify(at.rows)})`);
});
