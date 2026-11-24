// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-24 client a7 r1 #1 (P4, P8, P11: gap in the #3350 fix). #3350: a link naming one box several times outvoted the round's
// seats on GET /lock-settlement; its attack listed "/a,/b,/c" paths among the spellings. The fix (distinctSeats) keys a seat by origin +
// first path segment, so three paths of one box are still three seats, and their unsigned ACCEPTED settlement that leaves the winner out
// is the agreed one: lookOwed reads the payout 'none' (final once the stake is back), the record is closed, the payout never collected.
// Fixtures as in audit-client-a6-1-1.test.js (the #3350 test).
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


// distinctSeats (page-lock.js:2646) keys a seat by origin + FIRST PATH SEGMENT (join.js sourceKey), so http://liar.test/a, /b and /c of one
// box are still three seats on GET /lock-settlement - exactly the "/a,/b,/c" spelling #3350's attack named. SAFE: one box (one host) is one
// seat's word, however many paths the link gives it.
test('audit client a7 r1 #1: one box under three paths does not outvote the honest seats on the settlement (gap in #3350)', async () => {
  const honest = { 'a.test': { payees: [mine], forfeit: realForfeit }, 'b.test': { payees: [mine], forfeit: realForfeit } };
  const say = { ...honest, 'liar.test': { payees: [], forfeit: 'nope' } };
  const nodes = ['http://a.test', 'http://b.test', 'http://liar.test/a', 'http://liar.test/b', 'http://liar.test/c'];
  const fetcher = seats(say);
  const plain = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: ['http://a.test', 'http://b.test'], fetcher, client: wallet(100) });
  assert.equal(plain.payout.state, 'owed');
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher, client: wallet(100) });
  const s = await PL.settlementOf({ roundId: rid, nodes, fetcher, needed: PL.settlementAgreement(round, nodes), payee: mine });
  console.log('  FACTS a7-1-1:', JSON.stringify({ payout: lo.payout.state, final: lo.final, stake: lo.stake.state, agreeing: s.agreeing, needed: s.needed, seats: s.seats }));
  assert.equal(lo.payout.state, 'owed', 'one box named under three paths made the winner\'s payout "none"');
});
