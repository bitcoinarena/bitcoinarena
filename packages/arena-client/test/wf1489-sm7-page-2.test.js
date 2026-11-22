// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM7-PAGE-2 (state-machine audit round 7, area page): THE 24 H SCAN NEVER BRINGS BACK AN ORDER'S LOST COLLECT RECORD WHEN ANOTHER
// ORDER OF THE SAME ROUND IS KEPT.
//
// A tab's orders in one round are entries of their own, each with its own key (order 0, 1, 2 ...) and its own collect record
// (arena.collect.<round>.<seed16>[.oN], SM-L2). A record that was never written (saveCollect answers false when the browser is full even
// after the storage-full handler, or the tab died between the lock and the record) is what the 24 h scan (findTheRoundsOwed ->
// findOwedRounds) exists to bring back: the seats list the round's payout keys and the page derives every order's key. But the page tells
// the scan which rounds it already keeps BY ROUND ID ALONE (knownBySeed: savedCollects(...).map(r => r.roundIdHex)), and findOwedRounds skips
// a kept round before it derives any order's key - so while order 0's record is kept, order 2's payout is never found, no record is written
// for it, and nothing in the page ever collects it (the collect loop walks the records only).
//
// Drives index.html's own findTheRoundsOwed (lifted) over the real findOwedRounds / saveCollect / savedCollects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { pageFunction } from './page-script.js';
import { signedSeats } from './settled-signed.js';   // kanban #2108: seats sign their /settled answers

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const b32 = (n) => new Uint8Array(32).fill(n);
const FED = b32(0xa1);
const INVITE = inviteForGuardians(FED, [{ url: 'wss://a.example/', peer: 0 }]);
const now = BigInt(Date.now());
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x13), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: b32(0x15), simCoreHash: b32(0x14), startTimeMs: now - 3600000n, entryCloseMs: now - 3600000n + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: FED,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 7200000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: 10800, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const RID = toHex(rid);
const seed = b32(0x52);
const SEED = toHex(seed);
const keyOf = (order) => toHex(refundKeyOf(playerFor({ ...round, id: rid }, { seed, curve: pageCurve, order }).pubkey));
const NODES = ['http://a.test', 'http://b.test'];

function memStore() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
// the seats settled the round: it pays this phrase's order 0 AND its order 2 (two winning orders of one market round)
const seats = async (url) => {
  if (url.includes('/settled')) return new Response(JSON.stringify({ rounds: [{ id: RID, madeMs: Date.now() - 60000, payouts: [keyOf(0), keyOf(2)], refunds: [keyOf(0), keyOf(2)] }] }), { status: 200 });
  if (url.includes('/round?id=')) return new Response(encodeRoundContract(round), { status: 200 });
  return new Response('no', { status: 404 });
};
const SCAN_FROM = '    async function findTheRoundsOwed(named) {';
const SCAN_END = "      } catch (e) { console.error('[arena] owed: ' + e.message); return []; }\n    }\n";

test('wf1489-sm7-page-2: an order whose collect record was lost is found again by the 24 h scan while another order of its round is kept', async () => {
  const storage = memStore();
  storage.setItem('arena.seeds', JSON.stringify([{ hex: SEED }]));
  // the join kept order 0's record; order 2's saveCollect was refused (a full browser) - the lock was made, the entry went out, it won
  assert.equal(PL.saveCollect(storage, { roundIdHex: RID, round, invite: INVITE, nodes: NODES, seed, order: 0 }), true);
  const html = readFileSync(PAGE, 'utf8');
  const a = html.indexOf(SCAN_FROM); assert.ok(a > 0, 'index.html holds findTheRoundsOwed');
  const b = html.indexOf(SCAN_END, a); assert.ok(b > a);
  const ARENACLIENT = { ...PL, toHex, fromHex, findOwedRounds: (ask) => PL.findOwedRounds({ ...ask, fetcher: signedSeats(seats).fetcher }) };
  const window = { ARENA_CURVE: pageCurve, ARENA_TRACK: () => {}, ARENA_BROWSER_STORE: () => storage };
  const findTheRoundsOwed = pageFunction(PAGE, ['window', 'ARENACLIENT', 'collectSeed', 'vault', 'OWED_LOOKBACK_MS', 'lookThePayout'],
    [html.slice(a, b + SCAN_END.length)], 'return findTheRoundsOwed;')(window, ARENACLIENT, () => seed, () => storage, 24 * 3600 * 1000, () => {});
  await findTheRoundsOwed({ federation: INVITE, nodes: NODES });
  const orders = PL.savedCollects(storage, { seed }).filter((r) => r.roundIdHex === RID).map((r) => r.order).sort();
  console.log(`FACTS sm7-page-2: round ${RID.slice(0, 8)} pays orders 0 and 2 of this phrase; collect records kept after the scan: orders ${JSON.stringify(orders)}`);
  assert.deepEqual(orders, [0, 2], 'order 2 of a round whose order 0 is kept is never found by the scan: its payout is collected by nothing');
});
