// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2350 (the second hole): a slash-payout row was the wallet's growth over the whole collect - asking the arbitration service and the
// federation - while the page could lock the next stake from that same wallet, or an earlier lock's change could finish issuing. Now the row is
// what the refund itself brought, by the lock client's own two balance reads around it; a read another spend or issue cut counts the payout's amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const now = BigInt(Date.now());
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
const key = toHex(refundKeyOf(playerFor({ ...round, id: rid }, { seed, curve: pageCurve }).pubkey));
const PAYOUT = 60000000n;
const listed = { network: 'regtest', payouts: [{ round: toHex(rid), entry: 'e0'.repeat(32), refundPk: key, msat: String(PAYOUT), txid: '71'.repeat(32), outIdx: 0, contractId: 'c1'.repeat(32) }] };
const memStorage = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

/**
 * The player wallet: `bal` is what balanceMsat reads; the refund adds what it brings and says its own before/after, as the lock client does.
 * `meanwhile` runs while the arbitration service is asked - the page's next join locking from this wallet, an earlier lock's change issuing.
 */
const walletOf = ({ start, brings, cut = 0n }) => {
  const w = { bal: start, refunds: 0 };
  w.client = {
    async balanceMsat() { return String(w.bal); },
    async refund(txid, outIdx, fields) {
      const before = w.bal; w.bal += brings; const after = w.bal; w.bal -= cut; w.refunds += 1;
      return JSON.stringify({ accepted: true, txid: 'aa'.repeat(32), amount_msat: Number(JSON.parse(fields).amountMsat), balance_before: Number(before), balance_after: Number(cut ? w.bal : after), stored_before: { contract_id: 'c1'.repeat(32), blocks_left: 0 } });
    },
  };
  return w;
};
const collect = async (w, { meanwhile = () => {}, storage = memStorage() } = {}) => {
  const fetcher = async () => { meanwhile(w); return { ok: true, status: 200, json: async () => listed }; };
  const co = await PL.collectSlashPayout({ round, roundId: rid, invite: 'fed11x', seed, curve: pageCurve, storage, arbiter: 'https://arbiter.example', fetcher,
    LockClient: { join: async () => w.client, lockAllowanceMsat: () => '0' } });
  return { co, storage, rows: PL.ledgerRows(storage, round.federationId).map((r) => [r.kind, r.msat]) };
};

test('#2350 a slash-payout row says what the refund brought, not what the wallet grew while the page locked the next stake from it', async () => {
  const brings = PAYOUT - 256n;   // the payout less the federation's fee on the refund
  const w = walletOf({ start: 1362928n, brings });
  // while the arbitration service is asked: 31,072 msat of an earlier lock's change finish issuing, the next join locks 1,000,000 msat
  const { co, rows } = await collect(w, { meanwhile: (x) => { if (!x.moved) { x.moved = true; x.bal += 31072n; x.bal -= 1000000n; } } });
  console.log('  FACTS #2350 slash race:', JSON.stringify({ credited: String(co.creditedMsat), rows, refunds: w.refunds, wallet: String(w.bal) }));
  assert.equal(co.ok, true, co.why);
  assert.equal(w.refunds, 1);
  assert.deepEqual(rows, [['slash-payout', String(brings)]], 'the slash-payout row is not what the refund brought');
  assert.equal(co.creditedMsat, brings);
});

test('#2350 with nothing else moving the wallet, the slash-payout row is the wallet\'s growth as before', async () => {
  const brings = PAYOUT - 256n;
  const { co, rows } = await collect(walletOf({ start: 0n, brings }));
  assert.deepEqual(rows, [['slash-payout', String(brings)]]);
  assert.equal(co.creditedMsat, brings);
});

test('#2350 a slash refund whose own before/after a spend cut is counted at the payout\'s amount (old: the shortfall, or no row)', async () => {
  const w = walletOf({ start: 1294000n, brings: PAYOUT - 256n, cut: PAYOUT + 1000000n });   // the next join's lock lands between the refund's own reads
  const { co, rows } = await collect(w);
  console.log('  FACTS #2350 slash cut:', JSON.stringify({ credited: String(co.creditedMsat), rows, wallet: String(w.bal) }));
  assert.deepEqual(rows, [['slash-payout', String(PAYOUT)]]);
  assert.equal(co.creditedMsat, PAYOUT);
});

test('#2350 a slash payout read off its kept note writes no second row', async () => {
  const storage = memStorage();
  await collect(walletOf({ start: 0n, brings: PAYOUT - 256n }), { storage });
  const again = await collect(walletOf({ start: 5000000n, brings: PAYOUT - 256n }), { storage, meanwhile: (x) => { x.bal += 777n; } });
  assert.equal(again.co.kept, true);
  assert.equal(again.co.creditedMsat, 0n);
  assert.deepEqual(again.rows, [['slash-payout', String(PAYOUT - 256n)]]);
});
