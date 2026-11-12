// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM6 PAGE-3: collectIntoPlayerWallet writes its 'winnings' (or 'refund') history row from the player wallet's balance read before and
// after the collect - but that wallet is the one every inflow of the page lands in, and the collect runs beside them: the deposit resume
// (resumeDeposits, which writes its own deposit row at Claimed), the merge's receives, the welcome's e-cash, a second collect (ARENA_WITHDRAW and
// a Rescan after 90 s do not wait for the automatic pass). A deposit claimed while a payout is redeemed is booked twice: once as its deposit row,
// once inside the winnings row. The history - the only record the page keeps of what came in - then says more arrived than did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const now = BigInt(Date.now());
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x13), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: b32(0x15), simCoreHash: b32(0x14), startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: 10800, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x53);
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
const mine = toHex(refundKeyOf(player.pubkey));
const nodes = ['http://a.test', 'http://b.test'];
const seats = async (url) => {
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: mine, msat: '978000' }] } }), { status: 200 });
  return new Response('no', { status: 404 });
};
const tabStorage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
};

test('wf1489-sm6-page-3: a deposit claimed while a payout is collected is booked once in the history, not again inside the winnings row', async () => {
  const store = tabStorage();
  let bal = 0n;
  const pw = {
    async balanceMsat() { return String(bal); },
    async withdrawableMsat() { return String(bal); },
    async lockStatus() { return JSON.stringify({ block_count: 400, stored: { contract_id: 'p', blocks_left: 0 } }); },
    // the payout's redeem: 978000 msat credited; meanwhile the deposit resume's claim of an earlier page's 50000 msat invoice ends in the same wallet
    async refund() {
      bal += 978000n;
      bal += 50000n;
      PL.depositEnded(store, TEST_FEDERATION_ID, 'op-earlier-page', PL.DEPOSIT_STATE.CLAIMED, { operation: 'op-earlier-page', amountMsat: 50000n });
      return JSON.stringify({ accepted: true, amount_msat: 978000, stored_before: { contract_id: 'p', blocks_left: 0 } });
    },
  };
  const look = { payout: { state: 'owed', msat: 978000n }, stake: { state: 'none' }, payoutMsat: 978000n, stakeMsat: 0n, refundMsat: 0n, owedMsat: 978000n };
  const co = await PL.collectIntoPlayerWallet({ look, round, roundId: rid, invite: 'fed11x', seed, curve: pageCurve, storage: store, nodes, fetcher: seats,
    LockClient: { join: async () => pw, lockAllowanceMsat: () => '0' } });
  const rows = PL.ledgerRows(store, TEST_FEDERATION_ID).map((r) => [r.kind, r.msat]);
  const inRows = rows.filter(([k]) => k === 'deposit' || k === 'winnings' || k === 'refund').reduce((t, [, m]) => t + BigInt(m), 0n);
  console.log('  FACTS wf1489-sm6-page-3:', JSON.stringify({ collected: co.collected, credited: String(co.creditedMsat), walletGrew: String(bal), rows, inflowBooked: String(inRows) }));
  assert.equal(co.collected, true, 'the fixture: the payout was collected');
  assert.equal(inRows, bal, `the history books ${inRows} msat of inflow for a wallet that grew by ${bal}: the deposit is in its own row and again in the winnings row`);
});
