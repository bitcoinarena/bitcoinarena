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

// REFUTE #2 of #1489 CLIENT-1 (54e03252e): a STRANGER seat - one of the lobby's list that never sat on the round - answers /stake-lock with the
// player's REAL lock (same outpoint, same fields: it read them from any honest seat's public answer) under a made-up entryId. findLock keeps it as
// a second "version"; heldByGuardians keeps it too (same outpoint, same fields, same contract id); lookOwed reads the stake owed by forfeit (one good
// forfeit from any version is enough there) - but redeemStake demands a forfeit for EVERY held version and throws on the stranger's, so returnStake
// fails on every reload, for good: past the lock's expiry the look still says "owed by forfeit", so the expiry refund is never asked either.
const REAL_ENTRY = 'ee'.repeat(32);
const LIE_ENTRY = 'aa'.repeat(32);
const OUTPOINT = `${'cd'.repeat(32)}:0`;
const seatsWithStranger = (payees) => async (url) => {
  const u = new URL(url);
  const host = u.host;
  if (host === 'stranger.test') {
    if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: LIE_ENTRY, outpoint: OUTPOINT, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
    return new Response('no such round here', { status: 404 });
  }
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: payees.map((pk) => ({ kind: 'qualifier', pk, msat: '978000' })) } }), { status: 200 });
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: REAL_ENTRY, outpoint: OUTPOINT, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  if (url.includes('/forfeit')) {
    if (u.searchParams.get('entry') === REAL_ENTRY && !u.searchParams.get('lock')) return new Response(JSON.stringify({ signature: realForfeit, contractId: STORED, claimPk: toHex(CLAIM_PK) }), { status: 200 });
    return new Response('no such entry in this round', { status: 404 });
  }
  return new Response('no', { status: 404 });
};
// the federation: the lock held at its outpoint under STORED until redeemed with the real forfeit
const federation = (blocksLeft) => {
  const state = { spent: false, redeems: 0 };
  class Client {
    static outgoingContractId() { return STORED; }
    async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: state.spent ? null : { contract_id: STORED, blocks_left: blocksLeft } }); }
    async withdrawableMsat() { return '0'; }
    async balanceMsat() { return '0'; }
    async redeem(txid, outIdx, fieldsJson, sig) {
      if (state.spent) return JSON.stringify({ accepted: false, stored_before: null, error: 'No contract found' });
      if (sig !== realForfeit) return JSON.stringify({ accepted: false, stored_before: { contract_id: STORED }, error: 'bad signature' });
      state.spent = true; state.redeems++;
      return JSON.stringify({ accepted: true, amount_msat: 980000, txid: 'aa', balance_before: 0, balance_after: 980000 });
    }
    async refund() { return JSON.stringify({ accepted: false, error: 'not asked in this test' }); }
  }
  return { state, LockClient: Object.assign(Client, { join: async () => new Client() }), client: new Client() };
};
const nodes = ['http://a.test', 'http://b.test', 'http://stranger.test'];

for (const blocksLeft of [100, 0]) {
  test(`refute-5-s2: a stranger seat naming the real lock under a made-up entryId does not keep the stake from coming back (blocks left ${blocksLeft})`, async () => {
    const fed = federation(blocksLeft);
    const ask = { round, roundId: rid, seed, curve: pageCurve, nodes, fetcher: seatsWithStranger([]), LockClient: fed.LockClient, storage: null };
    const tries = [];
    let lo = null;
    // THE PAGE'S COLLECT ON THREE LOADS IN A ROW (the retry/resume path): look, then collect what the look says is owed
    for (let i = 0; i < 3; i++) {
      lo = await PL.lookOwed({ ...ask, client: fed.client });
      const got = await PL.collectOwed({ look: lo, client: fed.client, ...ask });
      tries.push({ stake: `${lo.stake.state}/${lo.stake.how || ''}`, stakeOk: got.stake ? got.stake.ok : null, refundOk: got.refund ? got.refund.ok : null,
        why: String((got.stake && got.stake.why) || '').slice(0, 90) });
      if (fed.state.spent) break;
    }
    const named = await PL.findLock({ roundId: rid, playerPubkey: player.pubkey, nodes, fetcher: seatsWithStranger([]) });
    console.log('  FACTS refute-5-s2:', JSON.stringify({ blocksLeft, versions: named.map((l) => String(l.entryId).slice(0, 4)), said: named.said, tries, redeemed: fed.state.redeems }));
    assert.equal(fed.state.spent, true, `the stake never came back: ${JSON.stringify(tries)}`);
  });
}

test('refute-5-s2 control: the same round with only its own two seats - the stake comes back by forfeit', async () => {
  const fed = federation(100);
  const own = ['http://a.test', 'http://b.test'];
  const ask = { round, roundId: rid, seed, curve: pageCurve, nodes: own, fetcher: seatsWithStranger([]), LockClient: fed.LockClient, storage: null };
  const lo = await PL.lookOwed({ ...ask, client: fed.client });
  const got = await PL.collectOwed({ look: lo, client: fed.client, ...ask });
  console.log('  FACTS refute-5-s2 control:', JSON.stringify({ stake: `${lo.stake.state}/${lo.stake.how}`, ok: got.stake && got.stake.ok }));
  assert.equal(fed.state.spent, true);
});
