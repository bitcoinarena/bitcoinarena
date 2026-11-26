// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT client a8-2-1: forfeitOf asks the record's nodes one after another, SEAT_READ_MS (15 s) each, deduplicated by exact
// spelling only. A link (role d, the stranger who shares the round link) that names one box under nine paths ahead of the
// round's seats - the box proxies every door honestly and only lets GET /forfeit hang - makes every look of the record run
// past COLLECT_RECORD_MS (120 s): the page's bounded collect gives up on every pass and the qualifier's stake never comes back,
// not even after the lock's expiry (lookOwed asks the forfeit before it reads the expiry).
// SAFE: one look of the record finishes inside the page's per-record bound and reads the stake owed by the honest seat's forfeit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
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
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
const mine = toHex(refundKeyOf(player.pubkey));
const CLAIM_SECRET = b32(0x77);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SECRET)]);
const STORED = 'c0'.repeat(32);
const fields = { paymentImage: { kind: 'point', bytes: Uint8Array.from([0x03, ...b32(0x5e)]) }, amountMsat: 980000n, claimPk: CLAIM_PK, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
const realForfeit = toHex(schnorr.sign(fromHex(STORED), CLAIM_SECRET));

let forfeitAsksAtBox = 0;
const fetcher = async (url, opts = {}) => {
  const u = new URL(url);
  const box = u.host === 'box.test';
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: mine, msat: '978000' }] } }), { status: 200 });
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  if (url.includes('/forfeit')) {
    if (box) {
      forfeitAsksAtBox++;
      // the box takes the request and never answers it: only the page's own deadline ends it
      return new Promise((_, no) => { const s = opts.signal; if (s) s.addEventListener('abort', () => no(s.reason || new Error('aborted')), { once: true }); });
    }
    return new Response(JSON.stringify({ signature: realForfeit, contractId: STORED, claimPk: toHex(CLAIM_PK) }), { status: 200 });
  }
  return new Response('no', { status: 404 });
};
const wallet = { async lockStatus() { return JSON.stringify({ block_count: 364, stored: { contract_id: STORED, blocks_left: 100 } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; } };

test('a8-2-1: one box under nine paths of the link does not hold the stake\'s forfeit past the page\'s per-record collect bound', { timeout: 400000 }, async () => {
  // the link the stranger shares: the box's nine paths first, then the round's honest seat
  const nodes = [...Array.from({ length: 9 }, (_, i) => `http://box.test/s${i}`), 'http://honest.test'];
  const t0 = Date.now();
  let look = null, why = null;
  try {
    look = await PL.collectWithin(() => PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher, client: wallet }));
  } catch (e) { why = e.message; }
  const facts = { ms: Date.now() - t0, boundMs: PL.COLLECT_RECORD_MS, forfeitAsksAtBox, stake: look ? `${look.stake.state}/${look.stake.how}` : null, why };
  console.log('  FACTS a8-2-1:', JSON.stringify(facts));
  assert.equal(why, null, `the look of the record ran past the page's ${PL.COLLECT_RECORD_MS} ms bound: ${why}`);
  assert.deepEqual([look.stake.state, look.stake.how], ['owed', 'forfeit']);
});
