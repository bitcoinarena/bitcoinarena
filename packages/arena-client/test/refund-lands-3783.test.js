// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3783 (feedback #560, round 9aff4727): the refund row said +1,940 sat and the balance never grew.
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

test('#3783 an accepted refund whose notes are still being issued writes no "+1,940" row; the row comes once they land (old: the row at once, balance unchanged)', async () => {
  const storage = memStorage(), w = walletOf(93000n);
  const co = await PL.collectIntoPlayerWallet({ look, ...ask(w, storage) });
  const at = { rows: rowsOf(storage), wallet: String(w.bal), credited: String(co.creditedMsat), refunds: w.refunds };
  console.log('  MEASURED #3783 accepted, not issued:', JSON.stringify(at));
  assert.equal(w.refunds, 1);
  assert.equal(co.collected, true, 'the lock is spent: the record is done');
  assert.deepEqual(at.rows, [], 'a row claims money the wallet does not show');
  assert.equal(co.creditedMsat, 0n);
  // a later pass before the notes landed: still none
  await PL.collectIntoPlayerWallet({ look: null, ...ask(w, storage) });
  assert.deepEqual(rowsOf(storage), []);
  w.land();
  await PL.collectIntoPlayerWallet({ look: null, ...ask(w, storage) });
  await PL.collectIntoPlayerWallet({ look: null, ...ask(w, storage) });
  console.log('  MEASURED #3783 landed:', JSON.stringify({ rows: rowsOf(storage), wallet: String(w.bal) }));
  assert.deepEqual(rowsOf(storage), [['refund', String(fields.amountMsat)]], 'one row, once the notes landed');
});

test('#3783 a refund whose notes landed in its own reads is its row at once, as before', async () => {
  const storage = memStorage(), w = walletOf(93000n);
  const r = w.client.refund;
  w.client.refund = async (...a) => { const s = JSON.parse(await r(...a)); w.land(); return JSON.stringify({ ...s, balance_after: Number(w.bal) }); };
  const co = await PL.collectIntoPlayerWallet({ look, ...ask(w, storage) });
  assert.deepEqual(rowsOf(storage), [['refund', String(fields.amountMsat)]]);
  assert.equal(co.creditedMsat, fields.amountMsat);
});

// THE STORE: a client's write after another client's never takes the other's as seen (the old client of the tab still issuing a refund's notes)
test('#3783 a wallet store that writes after another client wrote stays stale, so the wallet is opened again and sees those notes (old: not stale)', () => {
  const S = memStorage();
  const fid = round.federationId, sec = PL.walletSecretFor(seed, fid);
  const older = PL.walletStoreFor(S, fid, sec), current = PL.walletStoreFor(S, fid, sec);
  older.entries(); current.entries();
  older.put('aa01', '1');          // the older client stores the refund's notes
  current.put('bb02', '2');        // the current client writes anything after it
  console.log('  MEASURED #3783 store stale after a write over another\'s:', current.stale());
  assert.equal(current.stale(), true, 'the current client took the other client\'s notes as seen and never opens the wallet again');
  current.entries();
  assert.equal(current.stale(), false);
  current.put('bb03', '3');
  assert.equal(current.stale(), false, 'its own writes alone keep it fresh');
});
