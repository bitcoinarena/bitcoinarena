// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1163 (the 2026-11-06 state-machine audit): THE COLLECT - one seat's word finalised it, and a partial collect marked it done.
//
// Each test asks what the page asks (lookOwed, then collectIntoPlayerWallet's answer into markCollectDone, then tidyStorage) with seats
// that lie, and asserts what must hold. On the old source each fails: the measure is the FACTS line each prints.
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
// game-app constants as fixed bytes (the MacBook copy has no game-app deps)
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
const realForfeit = toHex(schnorr.sign(fromHex(STORED), CLAIM_SECRET));
const FAKE = 'ab'.repeat(64);


// REFUTE #3 of #1489 CLIENT-1 (kanban #1489): settlementOf groups answers by a key that reads a payout's kind as `p.kind || 'qualifier'`,
// and wellFormedPayouts (kanban #1671) lets the kind be absent - but the group's answer is its FIRST member's answer as that seat sent it,
// and redeemPayout / lookOwed find the player's payout with `p.kind === 'qualifier'`. One seat listed first that answers the honest
// settlement with the kinds left out joins the honest seats' group, stands for it, and the winner's payout reads "pays nothing" - final.
const TXID = 'ef'.repeat(32);
const settled = (withKind) => ({ state: 'ACCEPTED', txid: TXID, moved: { payouts: [withKind ? { kind: 'qualifier', pk: mine, msat: '978000' } : { pk: mine, msat: '978000' }] } });
const fetcherWith = (liar) => async (url) => {
  const host = new URL(url).host;
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify(host === 'liar.test' ? liar : settled(true)), { status: 200 });
  if (url.includes('/stake-lock')) return new Response('[]', { status: 200 });
  return new Response('not a qualifier', { status: 409 });
};
const nodes = ['http://liar.test', 'http://a.test', 'http://b.test'];
const wallet = { async lockStatus() { return JSON.stringify({ block_count: 1, stored: { contract_id: 'c0'.repeat(32), blocks_left: 100 } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; } };

test('wf1489-v1-refute-5-s3-1a: one seat answering the honest settlement without kinds does not make the winner\'s payout "none"', async () => {
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher: fetcherWith(settled(false)), client: wallet });
  console.log('  FACTS lookOwed, liar first without kinds: payout', lo.payout.state, 'final', lo.final);
  assert.equal(lo.payout.state, 'owed', 'the honest 2-of-2 settlement pays this key, but one seat\'s kind-less copy made it "none"');
});

test('wf1489-v1-refute-5-s3-1b: redeemPayout does not say "pays nothing" (final) when one seat drops the kinds', async () => {
  const got = await PL.redeemPayout({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher: fetcherWith(settled(false)), storage: null,
    LockClient: { async join() { return { async refund() { return JSON.stringify({ accepted: true }); } }; } } });
  console.log('  FACTS redeemPayout, liar first without kinds:', JSON.stringify({ ok: got.ok, final: got.final, why: got.why }));
  assert.equal(got.ok, true, `the payout was not collected: ${got.why}`);
});

test('wf1489-v1-refute-5-s3-1c: control - the same liar listed last changes nothing', async () => {
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: ['http://a.test', 'http://b.test', 'http://liar.test'], fetcher: fetcherWith(settled(false)), client: wallet });
  assert.equal(lo.payout.state, 'owed');
});
