// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.

//
// Each test asks what the page asks (lookOwed, then collectIntoPlayerWallet's answer into markCollectDone, then tidyStorage) with seats
// that lie, and asserts what must hold. On the old source each fails: the measure is the FACTS line each prints.
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

// WF1489 r7 CLIENT-1: settlementOf's "short" answer (one seat, below the round's settlement threshold, that pays the player) is handed back so
// the federation checks it at the spend. But lookOwed reads an outpoint the federation does not hold as "gone" (collected before by this key),
// and redeemPayout reads it as "already spent": both FINAL. One seat answering ACCEPTED with a made-up txid that pays the player - while the
// honest seats have not accepted the real settlement yet - closes the winner's record: collectState says done and the real payout is never
// collected. Safe: a payout outpoint named only by a short (below-threshold) answer and not held by the federation is not final.
const LIAR_TXID = '66'.repeat(32);
const say = async (url) => {
  const host = new URL(url).host;
  if (url.includes('/lock-settlement')) {
    if (host === 'liar.test') return new Response(JSON.stringify({ state: 'ACCEPTED', txid: LIAR_TXID, moved: { payouts: [{ kind: 'qualifier', pk: mine, msat: '978000' }] } }), { status: 200 });
    return new Response(JSON.stringify({ state: 'PENDING' }), { status: 200 });   // the honest seat: the real settlement is not accepted yet
  }
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  return new Response('no', { status: 404 });
};
// the federation: nothing at the liar's made-up outpoint (and the stake already came back by its forfeit, noted below)
const fed = {
  async lockStatus(txid) { return JSON.stringify({ block_count: 400, stored: txid === LIAR_TXID ? null : { contract_id: STORED, blocks_left: 50 } }); },
  async refund() { return JSON.stringify({ accepted: false, stored_before: null, error: 'no contract at that outpoint' }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
};

test('WF1489 r7 CLIENT-1: one seat\'s short /lock-settlement with a made-up txid does not make the winner\'s payout final', async () => {
  const m = new Map();
  const storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  m.set(`arena.stakeback.${toHex(rid)}.${mine.slice(0, 16)}`, JSON.stringify({ ok: true, amountMsat: '980000' }));   // the stake came back by its forfeit
  const nodes = ['http://liar.test', 'http://honest.test'];
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher: say, client: fed, storage });
  const st = PL.collectState(lo);
  const rp = await PL.redeemPayout({ round, roundId: rid, seed, curve: pageCurve, storage, nodes, fetcher: say, client: fed });
  const facts = { payout: lo.payout.state, final: lo.final, collectState: st.state, redeemFinal: rp.final, redeemWhy: rp.why };
  console.log('  FACTS WF1489 r7 CLIENT-1:', JSON.stringify(facts));
  assert.equal(lo.final, false, 'one seat\'s below-threshold settlement with a made-up txid made the winner\'s payout final ("gone")');
  assert.equal(st.state, 'open', 'the record would be marked done and never looked at again');
  assert.equal(rp.final, false, 'redeemPayout called a made-up outpoint "already spent" and final');
});
