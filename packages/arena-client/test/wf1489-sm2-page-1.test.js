// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 page-1: AN ORDER'S FEE LOCK LEFT IN THE FEDERATION WHEN ITS FORFEIT MISSED THE ONE COLLECT THAT REDEEMED THE STAKE.
//
// The seats' GET /stake-lock names the stake lock only; the order's fee lock is known to the tab alone (its saved lock). redeemStake asks
// the fee lock's forfeit once, beside the stake's: a fee forfeit that does not come on that ask (the seats' MuSig for it failed, a peer
// timed out, one seat's pair was spent - each answers 409/500 and is asked again on the next ask) is simply left out, the stake is
// redeemed, its note written, and from then on lookOwed reads the stake 'collected' and the round final: the fee lock is never asked again,
// not by forfeit and not by the player's key after its expiry (only the "no seat names a lock" branch refunds a kept fee lock).
// The invariant: a lock this tab made that the federation still holds past its expiry is never read final with nothing owed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor, stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
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
const ORDER = 1;
const CLAIM_SECRET = b32(0x77);
const CLAIM = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SECRET)]);
const STAKE_ID = 'c1'.repeat(32), FEE_ID = 'c2'.repeat(32);   // the contract ids the guardians hold at the two outpoints
const STAKE_TX = b32(0xd1), FEE_TX = b32(0xd2);

function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

test('a fee forfeit missed on the one collect that redeemed the stake: the fee lock is never owed again, even past its expiry', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve, order: ORDER });
  const refund = refundKeyOf(player.pubkey);
  const stake = await stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((n) => pageCurve.pointX(b32(n))), curve: pageCurve,
    random: (n) => new Uint8Array(n).fill(9), playerPubkey: player.pubkey, needed: 2 });
  const fields = { paymentImage: { kind: 'point', bytes: stake.stakePoint }, amountMsat: 54450n, claimPk: CLAIM, refundPk: refund, expiration: 464 };
  const feeFields = { paymentImage: { kind: 'hash', bytes: b32(0x66) }, amountMsat: 550n, claimPk: CLAIM, refundPk: refund, expiration: 464 };
  const storage = tab();
  PL.saveLock(storage, { roundId: rid, playerPubkey: player.pubkey, stake, lock: { outpoint: { txid: STAKE_TX, outIdx: 0n }, fields,
    feeLock: { preimage: b32(0x67), outpoint: { txid: FEE_TX, outIdx: 0n }, fields: feeFields } } });

  // THE SEATS: an unfilled order - both locks come back by forfeit. The fee's forfeit fails on the first ask (its MuSig did not form), then stands.
  let feeAnswers = false;
  const fetcher = async (url) => {
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [] } }), { status: 200 });
    if (url.includes('/stake-lock')) return new Response(JSON.stringify(url.includes(`refund=${toHex(refund)}`)
      ? [{ entryId: 'ee'.repeat(32), outpoint: `${toHex(STAKE_TX)}:0`, fields: lockFieldsToJson(fields) }] : []), { status: 200 });
    if (url.includes('/forfeit') && url.includes('lock=fee')) return feeAnswers
      ? new Response(JSON.stringify({ signature: toHex(schnorr.sign(fromHex(FEE_ID), CLAIM_SECRET)), contractId: FEE_ID, claimPk: toHex(CLAIM) }), { status: 200 })
      : new Response('2 of the 2 signer nodes the forfeit needs committed to it: http://b.test: the operation was aborted due to timeout', { status: 409 });
    if (url.includes('/forfeit')) return new Response(JSON.stringify({ signature: toHex(schnorr.sign(fromHex(STAKE_ID), CLAIM_SECRET)), contractId: STAKE_ID, claimPk: toHex(CLAIM) }), { status: 200 });
    return new Response('no', { status: 404 });
  };
  // THE FEDERATION as the round wallet reads it: both locks stored until redeemed; the fee lock's blocks left set by the test
  const spent = new Set();
  let feeLeft = 100;
  const client = {
    async lockStatus(txid) {
      if (spent.has(txid)) return JSON.stringify({ block_count: 464, stored: null });
      if (txid === toHex(STAKE_TX)) return JSON.stringify({ block_count: 364, stored: { contract_id: STAKE_ID, blocks_left: 100 } });
      if (txid === toHex(FEE_TX)) return JSON.stringify({ block_count: 464 - feeLeft, stored: { contract_id: FEE_ID, blocks_left: feeLeft } });
      return JSON.stringify({ stored: null });
    },
    async redeem(txid, outIdx, f) { spent.add(txid); return JSON.stringify({ accepted: true, amount_msat: Number(JSON.parse(f).amountMsat) }); },
    async refund(txid, outIdx, f) { spent.add(txid); return JSON.stringify({ accepted: true, amount_msat: Number(JSON.parse(f).amountMsat) }); },
    async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
  };
  const ask = { round, roundId: rid, invite: INVITE, seed, curve: pageCurve, storage, nodes: ['http://a.test', 'http://b.test'], fetcher, client, order: ORDER };

  // 1. the look: the stake owed by forfeit; 2. the collect (collectOwed's returnStake): the stake redeemed, the fee forfeit missed this once
  const first = await PL.lookOwed(ask);
  const got = await PL.returnStake({ ...ask, forfeited: first.stake.state === 'owed' && first.stake.how === 'forfeit' });
  // 3. the seats' fee forfeit stands now, and later the fee lock is past its expiry - still stored in the federation
  feeAnswers = true;
  const later = await PL.lookOwed(ask);
  feeLeft = 0;
  const expired = await PL.lookOwed(ask);
  const facts = { firstStake: `${first.stake.state}/${first.stake.how}`, collect: { ok: got.ok, redeemed: got.amountMsat && String(got.amountMsat) },
    feeStillHeld: !spent.has(toHex(FEE_TX)),
    later: { stake: later.stake.state, owedMsat: String(later.owedMsat), final: later.final, collect: PL.collectState(later).state },
    pastExpiry: { stake: expired.stake.state, owedMsat: String(expired.owedMsat), final: expired.final, collect: PL.collectState(expired).state } };
  console.log('  FACTS sm2-page-1:', JSON.stringify(facts));
  assert.equal(first.stake.state, 'owed');
  assert.equal(got.ok, true, 'the stake was redeemed');
  assert.ok(facts.feeStillHeld, 'precondition: the fee lock is still in the federation');
  // THE INVARIANT: the federation still holds this tab's fee lock (550 msat) - the round is not final, and past its expiry it is owed back
  assert.ok(!(expired.final && expired.owedMsat === 0n),
    `the round reads final with nothing owed while the tab's 550 msat fee lock lies in the federation past its expiry (${JSON.stringify(facts.pastExpiry)})`);
  assert.notEqual(PL.collectState(expired).state, 'done', 'the collect record would be written done with the fee lock still held');
  // THE FIX (kanban #1642): the fee lock has its own state - owed by its forfeit once the seats give it, by refund past its expiry
  assert.equal(later.stake.state, 'owed'); assert.equal(later.stake.how, 'forfeit'); assert.equal(later.owedMsat, 550n); assert.equal(later.final, false);
  assert.equal(expired.stake.how, 'refund'); assert.equal(expired.owedMsat, 550n);
  // the collect of the forfeit look redeems the fee lock alone; the next look reads the round final with nothing owed
  const gotFee = await PL.collectOwed({ look: later, ...ask });
  assert.equal(gotFee.stake.ok, true); assert.equal(gotFee.stake.amountMsat, 550n);
  assert.ok(spent.has(toHex(FEE_TX)), 'the fee lock was redeemed');
  const after = await PL.lookOwed(ask);
  assert.equal(after.stake.state, 'collected'); assert.equal(after.final, true); assert.equal(after.owedMsat, 0n);
  assert.equal(PL.collectState(after).state, 'done');
});
