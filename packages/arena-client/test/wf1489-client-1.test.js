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

// WF1489 CLIENT-1: ONE SEAT'S MALFORMED ANSWER STOPS THE WHOLE COLLECT. findLock and settlementOf parse each seat's JSON outside
// their per-seat try: a single seat answering `{}` at /stake-lock, or a payout list holding `null` at /lock-settlement, throws for
// the whole call - the honest seats' answers are dropped, the payout and stake are never collected while that one seat answers so.
const liarSeats = (honest, lie) => async (url) => {
  const host = new URL(url).host;
  if (host === 'liar.test') return new Response(JSON.stringify(lie(url)), { status: 200 });
  return honest(url);
};
const honestSay = { 'a.test': { payees: [mine], forfeit: realForfeit }, 'b.test': { payees: [mine], forfeit: realForfeit } };
const wallet = (blocksLeft) => ({
  async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: { contract_id: STORED, blocks_left: blocksLeft } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
});
const nodes = ['http://liar.test', 'http://a.test', 'http://b.test'];

test('wf1489-client-1a: one seat answering {} at /stake-lock does not hide the lock the honest seats name', async () => {
  const fetcher = liarSeats(seats(honestSay), (url) => (url.includes('/stake-lock') ? {} : { state: 'NONE' }));
  let got, err = null;
  try { got = await PL.findLock({ roundId: rid, playerPubkey: player.pubkey, nodes, fetcher }); } catch (e) { err = e.message; }
  console.log('  FACTS findLock with one {} seat:', err ? `threw: ${err}` : `${got.length} lock(s)`);
  assert.equal(err, null, `one seat's {} made findLock throw: ${err}`);
  assert.equal(got.length, 1);
});

test('wf1489-client-1b: one seat answering [null] at /stake-lock does not hide the lock the honest seats name', async () => {
  const fetcher = liarSeats(seats(honestSay), (url) => (url.includes('/stake-lock') ? [null] : { state: 'NONE' }));
  let got, err = null;
  try { got = await PL.findLock({ roundId: rid, playerPubkey: player.pubkey, nodes, fetcher }); } catch (e) { err = e.message; }
  console.log('  FACTS findLock with one [null] seat:', err ? `threw: ${err}` : `${got.length} lock(s)`);
  assert.equal(err, null, `one seat's [null] made findLock throw: ${err}`);
  assert.equal(got.length, 1);
});

test('wf1489-client-1c: one seat answering a payout list with null in it does not stop the settlement the honest seats agree on', async () => {
  const fetcher = liarSeats(seats(honestSay), (url) => (url.includes('/lock-settlement') ? { state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [null] } } : []));
  let s, err = null;
  try { s = await PL.settlementOf({ roundId: rid, nodes, fetcher, needed: 2, payee: mine }); } catch (e) { err = e.message; }
  console.log('  FACTS settlementOf with one [null] payouts seat:', err ? `threw: ${err}` : `ok=${s.ok} agreeing=${s.agreeing}`);
  assert.equal(err, null, `one seat's payouts [null] made settlementOf throw: ${err}`);
  assert.equal(s.agreeing, 2);
});

test('wf1489-client-1d: the winner\'s look (lookOwed) still says payout owed when one seat answers malformed', async () => {
  const fetcher = liarSeats(seats(honestSay), (url) => (url.includes('/lock-settlement') ? { state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [null] } } : {}));
  let lo, err = null;
  try { lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher, client: wallet(100) }); } catch (e) { err = e.message; }
  console.log('  FACTS lookOwed with one malformed seat:', err ? `threw: ${err}` : `payout ${lo.payout.state}, stake ${lo.stake.state}`);
  assert.equal(err, null, `one malformed seat made the whole look throw: ${err}`);
  assert.equal(lo.payout.state, 'owed');
});
