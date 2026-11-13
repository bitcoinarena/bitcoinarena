// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM4 PAGE-1: AN INTENT UNDER A REFUSED RECORD IS WRITTEN OVER, its transaction named nowhere.
// SM-L1 keeps an intent a closed tab left (older than LOCK_INTENT_LIVE_MS, not failed) as arena.lock.orphan.* before a new PLAY writes its
// own intent (#1162). keptLockStake reads the state with lockRecordOf, which reads the saved record FIRST - a round whose earlier lock was
// refused (reconcileKeptLock) answers 'refused' and the intent the dead tab left under it is invisible: neither the 120 s "another tab is
// locking" guard nor the orphan copy runs, and the new intent is written over it. The transaction that dead tab submitted (it may hold the
// stake at the guardians) is then named nowhere in the browser.
// Path: PLAY 1 -> lock refused by the guardians -> reload reads it refused -> PLAY 2 -> lockSubmit answered, txid written into the intent ->
// the tab dies (or saveLock is refused for room and the intent is put back, as keptLockStake does) -> reload -> PLAY 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { CLAIM } from '../../arena-node/test/lock-fixture.js';
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
const claimKey = { ok: true, claimPk: CLAIM, ref: b32(0x9a) };
const player = pageCurve.pointX(b32(0x62));
const who = { roundId: rid, playerPubkey: player };

function browser() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}
function lockClient({ refuse = false, fed = new Map() } = {}) {
  const log = []; let n = 0;
  class Fake {
    static async join() { return new Fake(); }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor() { this.balance = 10n ** 8n; }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String(this.balance); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta) {
      const txid = (0x40 + (++n) + (refuse ? 0x10 : 0)).toString(16).padStart(2, '0').repeat(32);
      log.push({ lockSubmit: txid });
      fed.set(txid, refuse ? 'refused' : 'accepted');
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: 's1', computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: 'f1', computed_expiration: exp, amount_msat: Number(feeMsat) });
      return JSON.stringify({ operation: `op${n}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub);
      await new Promise((r) => setTimeout(r, 5));
      if (fed.get(s.txid) !== 'accepted') throw new Error('the guardians did not accept the lock transaction: spent inputs');
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockStatus(txid) { return JSON.stringify({ block_count: 1001, stored: fed.get(txid) === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : null }); }
  }
  return { LockClient: Fake, log, fed };
}
const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });
const play = (storage, LockClient, stake) => PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient,
  storage, keep: true, federationId: round.federationId });

test('wf1489-sm4-page-1: an intent a dead tab left under a REFUSED record is kept aside, never written over (as under none)', async () => {
  const stake = await dealt();
  const storage = browser();
  // PLAY 1: the guardians refuse the lock; the reload reads it refused (reconcileKeptLock, 3 reads)
  const r = lockClient({ refuse: true });
  const m1 = await play(storage, r.LockClient, stake);
  await assert.rejects(() => m1.accepted, /did not accept/);
  await PL.reconcileKeptLock(storage, { ...who, client: new r.LockClient(), waitMs: 1 });
  assert.equal(PL.savedLock(storage, who).state, 'refused');
  // PLAY 2 in a tab that then died after its transaction went out: its intent names the submitted txid (as keptLockStake writes it, and
  // as it puts it back when saveLock is refused), 5 min old
  const iKey = `arena.lock.intent.${toHex(rid)}.${toHex(player).slice(0, 16)}`;
  const deadTx = '77'.repeat(32);
  storage.setItem(iKey, JSON.stringify({ v: 2, state: 'intent', atMs: Date.now() - 300000, preimage: toHex(stake.preimage), body: toHex(stake.body),
    amountMsat: '1000000', refundPk: '00', txid: deadTx, operation: 'op-dead', room: '' }));
  // PLAY 3 after the reload
  const c = lockClient();
  const m3 = await play(storage, c.LockClient, stake);
  await m3.accepted;
  const orphan = [...storage.m].filter(([k]) => k.startsWith('arena.lock.orphan.'));
  const named = [...storage.m.values()].some((v) => v.includes(deadTx));
  console.log('  FACTS wf1489-sm4-page-1:', JSON.stringify({ stateBefore: 'refused', orphans: orphan.length, deadTxNamedInBrowser: named,
    record: toHex(PL.savedLock(storage, who).lock.outpoint.txid).slice(0, 8) }));
  assert.ok(named, 'the transaction the dead tab submitted (it may hold the stake) is named nowhere in this browser after the next PLAY: the intent under the refused record was written over without an orphan copy');
});
