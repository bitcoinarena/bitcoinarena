// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2350: a refund row said +25 of 100 sat - the collect wrote the wallet's growth over its whole run, and the page spent from that wallet meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
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
const realForfeit = toHex(schnorr.sign(fromHex(STORED), CLAIM_SECRET));
const FAKE = 'ab'.repeat(64);

/**
 * Seats: `say[host]` is what that seat answers - `settled` (its settlement pays `payees`), `forfeit` (a signature, or a refusal text).
 * Every seat names the same lock (findLock).
 */
const seats = (say) => async (url) => {
  const host = new URL(url).host;
  const s = say[host] || {};
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify(s.settled === false ? { state: 'NONE' }
    : { state: 'ACCEPTED', txid: s.txid || 'ef'.repeat(32), moved: { payouts: (s.payees || []).map((pk) => ({ kind: 'qualifier', pk, msat: '978000' })) } }), { status: 200 });
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  if (url.includes('/forfeit')) return /^[0-9a-f]{128}$/.test(String(s.forfeit || '')) ? new Response(JSON.stringify({ signature: s.forfeit, contractId: STORED, claimPk: toHex(CLAIM_PK) }), { status: 200 })
    : new Response(s.forfeit || 'not a qualifier', { status: 409 });
  return new Response('no', { status: 404 });
};

/**
 * The player wallet: `bal` is what balanceMsat reads; the stake's redeem adds what it brings and says its own before/after, as the lock client does.
 * `meanwhile` runs when the guardians are asked whether they hold the lock - the time the collect spends asking seats and the federation, while
 * the page's next join spends from the same wallet and change notes of an earlier lock finish issuing (kanban #2350).
 */
const playerWalletOf = ({ start, meanwhile = () => {}, brings }) => {
  const w = { bal: start, redeemed: 0 };
  w.client = {
    async lockStatus() { meanwhile(w); return JSON.stringify({ block_count: 400, stored: { contract_id: STORED, blocks_left: 64 } }); },
    async balanceMsat() { return String(w.bal); },
    async redeem() { const before = w.bal; w.bal += brings; w.redeemed += 1; return JSON.stringify({ forfeit_verifies: true, accepted: true, amount_msat: Number(fields.amountMsat), balance_before: Number(before), balance_after: Number(w.bal), stored_before: { contract_id: STORED, blocks_left: 64 } }); },
  };
  return w;
};
const memStorage = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const say = { 'a.test': { settled: false, forfeit: realForfeit }, 'b.test': { settled: false, forfeit: realForfeit } };
const collect = async (w) => {
  const storage = memStorage();
  const lo = { payout: { state: 'none' }, stake: { state: 'owed', how: 'forfeit', msat: fields.amountMsat, entryId: 'ee'.repeat(32) }, payoutMsat: 0n, stakeMsat: fields.amountMsat, refundMsat: 0n, owedMsat: fields.amountMsat, inTabMsat: 0n, final: false };
  const co = await PL.collectIntoPlayerWallet({ look: lo, round, roundId: rid, invite: 'fed11x', seed, curve: pageCurve, storage, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: seats(say),
    LockClient: { join: async () => w.client, lockAllowanceMsat: () => '0' } });
  const note = Array.from({ length: storage.length }, (_, i) => storage.key(i)).find((k) => k.startsWith('arena.stakeback.'));
  return { co, note: note ? JSON.parse(storage.getItem(note)) : null, rows: PL.ledgerRows(storage, round.federationId).map((r) => [r.kind, r.msat]) };
};

// LIVE 2026-11-12 05:39Z (page999, wallet true-boar-1480, round 4e1c1615, never entered): the seats forfeited the 94,000 msat of stake and fee lock, the
// federation accepted both redeems (wallet 1,294,000 -> 1,388,000 msat), and the history said "Refund +25 of 100 sat". The row was the wallet's growth
// from the collect's start (1,362,928 msat, 31,072 still being issued from the lock before) to its end, and the page's next join locked 100,000 msat
// out of the same wallet in between: 94,000 - 100,000 + 31,072 = 25,072.
test('#2350 a refund row says what the redeem brought, not what the wallet grew while the page locked the next stake from it (old: 25,072 of 94,000)', async () => {
  const brings = 977920n;   // the stake's 980,000 msat less the federation's fee on the redeem, as it lands in the wallet
  const w = playerWalletOf({ start: 1362928n, brings, meanwhile: (x) => { if (!x.moved) { x.moved = true; x.bal += 31072n; x.bal -= 1000000n; } } });
  const { co, rows, note } = await collect(w);
  assert.ok(note && note.final, 'the stake\'s note was not kept: a reload would ask the seats again');
  console.log('  FACTS #2350 race:', JSON.stringify({ credited: String(co.creditedMsat), rows, redeemed: w.redeemed, accepted: !!(co.got.stake && co.got.stake.ok), wallet: String(w.bal) }));
  assert.equal(w.redeemed, 1);
  assert.equal(co.got.stake.ok, true, 'the stake\'s redeem was not accepted: ' + co.got.stake.why);
  assert.deepEqual(rows, [['refund', String(brings)]], 'the refund row is not what the redeem brought');
  assert.equal(co.creditedMsat, brings);
});

test('#2350 with nothing else moving the wallet, the row is the wallet\'s growth as before (the redeem fee off the lock\'s amount)', async () => {
  const brings = 977920n;
  const { co, rows } = await collect(playerWalletOf({ start: 1294000n, brings }));
  assert.deepEqual(rows, [['refund', String(brings)]]);
  assert.equal(co.creditedMsat, brings);
});

test('#2350 a redeem whose own before/after a spend cut is counted at the lock\'s amount, never less (old: the shortfall, or no row)', async () => {
  // the next join's lock lands between the redeem's own two balance reads
  const w = playerWalletOf({ start: 1294000n, brings: 977920n });
  const r = w.client.redeem;
  w.client.redeem = async (...a) => { const s = JSON.parse(await r(...a)); w.bal -= 1000000n; return JSON.stringify({ ...s, balance_after: Number(w.bal) }); };
  const { co, rows } = await collect(w);
  console.log('  FACTS #2350 cut:', JSON.stringify({ credited: String(co.creditedMsat), rows, redeemed: w.redeemed, wallet: String(w.bal) }));
  assert.deepEqual(rows, [['refund', String(fields.amountMsat)]]);
  assert.equal(co.creditedMsat, fields.amountMsat);
});
