// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-22b client r1 #1 (P4, P8; gap in the #1163 / #2014 fix, a door #3307 does not cover): settlementOf counts the seats that
// agree on a round's settlement by the node URL STRING (`new Set(nodes)`), and settlementAgreement caps the threshold by the same count.
// A join / lobby link names its node= list with no dedup (join.js joinQuery), and the collect record keeps that list (saveCollect nodes).
// One box named twice - http://liar.test and http://liar.test/ (or two junk paths) - is two "seats": its unsigned ACCEPTED /lock-settlement
// that leaves the winner out is a group as large as the round's threshold (and larger than the honest seats with a third spelling), so
// lookOwed reads the winner's payout as 'none' and the record is final - the payout contract is never collected.
// SAFE: one box answering under several spellings of its URL is one seat's word; the honest seats' settlement that pays the player stands.
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
/** The federation as the player wallet reads it: the lock at its outpoint, `blocksLeft` before its expiry; the payout contract held too. */
const wallet = (blocksLeft) => ({
  async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: { contract_id: STORED, blocks_left: blocksLeft } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
});
const look = (say, blocksLeft = 100) => PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: seats(say), client: wallet(blocksLeft) });


test('audit client r1 #1: one box under three spellings of its URL does not outvote the honest seats on the settlement', async () => {
  // the round's two honest seats (threshold 2 of 2) both hold the settlement that pays this player
  const honest = { 'a.test': { payees: [mine], forfeit: realForfeit }, 'b.test': { payees: [mine], forfeit: realForfeit } };
  const liar = { payees: [], forfeit: 'nope' };
  const say = { ...honest, 'liar.test': liar };
  // the link's node= list: the honest seats, and the one liar box three times (a trailing slash, and a doubled one)
  const nodes = ['http://a.test', 'http://b.test', 'http://liar.test', 'http://liar.test/', 'http://liar.test//'];
  const asked = new Set();
  const fetcher = async (url, o) => { asked.add(new URL(url).host); return seats(say)(url, o); };
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher, client: wallet(100) });
  const s = await PL.settlementOf({ roundId: rid, nodes, fetcher, needed: PL.settlementAgreement(round, nodes), payee: mine });
  const facts = { boxes: [...asked], payout: lo.payout.state, final: lo.final, agreeing: s.agreeing, seats: s.seats };
  console.log('  FACTS audit client r1 #1:', JSON.stringify(facts));
  // without the liar the payout is owed (the control)
  const plain = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: ['http://a.test', 'http://b.test'], fetcher: seats(honest), client: wallet(100) });
  assert.equal(plain.payout.state, 'owed');
  assert.equal(lo.payout.state, 'owed', 'one box named under three URL spellings made the winner\'s payout "none"');
});
