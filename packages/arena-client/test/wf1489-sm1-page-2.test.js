// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-page-2 (state-machine audit, the page's stake lock record SM-L1): A LOCK READ "NOT STORED" FOR 6 SECONDS IS NOT A REFUSED LOCK.
// A reload while the kept lock is still `submitted` reads it in the federation 3 times 2 s apart (reconcileKeptLock); stored nowhere yet - the
// guardians' consensus has not reached the transaction (a slow session, a guardian down) - it is written `refused`, and the next PLAY writes a
// new lock over that record (refused -> intent -> submitted, no orphan copy, unlike an abandoned intent). When the guardians then accept the
// first transaction, its stake sits in a lock this browser names nowhere: no record, no outpoint, no fields - the collect's expiry refund
// (lookOwed reads the tab's own record) can never reach it. Safe: a lock that may still be accepted is never written over and forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { CLAIM } from '../../arena-node/test/lock-fixture.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const now = BigInt(Date.now());
// no donation chosen: the lock is the stake (and its fee lock) alone
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

/** The browser's storage; `room` characters at most, past it a write throws QuotaExceededError as Safari's does. */
function browser(room = Infinity) {
  const m = new Map();
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  let peak = 0;
  return { get peak() { return peak; }, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const was = m.has(k) ? k.length + m.get(k).length : 0;
      if (used() - was + k.length + String(v).length > room) { const e = new Error(`Setting the value of '${k}' exceeded the quota.`); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v)); peak = Math.max(peak, used());
    }, removeItem: (k) => { m.delete(k); }, m, set room(r) { room = r; } };
}

const tx = (n) => n.toString(16).padStart(2, '0').repeat(32);
/** A lock client over `fed` (txid -> 'pending' | 'accepted'). `slow`: the guardians have not reached the transaction yet and this tab's
 * acceptance wait never ends (the tab is reloaded before it does). */
function lockClient(fed, { slow = false, first = 1 } = {}) {
  const log = [];
  let n = first - 1;
  class Fake {
    static async join() { return new Fake(); }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor() { this.balance = 10n ** 8n; }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String(this.balance); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta) {
      const txid = tx(++n);
      log.push({ lockSubmit: txid });
      this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      fed.set(txid, slow ? 'pending' : 'accepted');
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: 's1', computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: 'f1', computed_expiration: exp, amount_msat: Number(feeMsat) });
      return JSON.stringify({ operation: `op${n}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub);
      if (fed.get(s.txid) !== 'accepted') return new Promise(() => {});   // the tab is gone before the guardians answer
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockStatus(txid) {
      return JSON.stringify({ block_count: 1001, stored: fed.get(txid) === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : null });
    }
  }
  return { LockClient: Fake, log };
}
const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });
/** THE PAGE'S LOCK STEP (index.html: lockStake with `keep`). */
const pageLocks = (storage, LockClient, stake) => PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient, storage,
  keep: true, federationId: round.federationId });
/** THE PAGE'S RELOAD (index.html 4096-4110): the kept lock, its use, a 'check' read in the federation first (3 reads, here 1 ms apart). */
async function pageReloads(storage, client) {
  let kept = PL.savedLock(storage, who);
  let use = PL.keptLockUse(kept, { entry: null, beforeStart: true, beforeClose: true });
  if (use.use === 'check') { kept = await PL.reconcileKeptLock(storage, { ...who, client, waitMs: 1 }); use = PL.keptLockUse(kept, { entry: null, beforeStart: true, beforeClose: true }); }
  return use;
}

test('wf1489-sm1-page-2: a lock the guardians accept after the reload read it "not stored" is still named in the browser after the next PLAY', async () => {
  const fed = new Map();
  const storage = browser();
  // PLAY: the lock submitted, the guardians' session slow; the tab is reloaded before the acceptance comes
  const a = lockClient(fed, { slow: true, first: 1 });
  const first = await pageLocks(storage, a.LockClient, await dealt());
  const tx1 = toHex(first.outpoint.txid);
  assert.equal(PL.savedLock(storage, who).state, 'submitted');
  // THE RELOAD: three reads, not stored yet -> refused, and the page makes a new lock
  const use = await pageReloads(storage, new a.LockClient());
  // THE NEXT PLAY: a new lock, accepted at once
  const b = lockClient(fed, { first: 2 });
  const second = await pageLocks(storage, b.LockClient, await dealt());
  await second.accepted;
  // THE GUARDIANS' CONSENSUS REACHES THE FIRST TRANSACTION: its stake is locked under this player's refund key
  fed.set(tx1, 'accepted');
  const stored = JSON.parse(await new a.LockClient().lockStatus(tx1)).stored;
  // what the page's lock records hold (the kept record, an intent, an orphan): the only places the collect or a person can find a lock's outpoint
  const namedAnywhere = [...storage.m].some(([k, v]) => k.startsWith('arena.lock.') && v.includes(tx1));
  const facts = { reloadUse: use.use, firstTx: tx1.slice(0, 8), firstStored: !!stored, secondTx: toHex(second.outpoint.txid).slice(0, 8),
    keptRecordTx: toHex(PL.savedLock(storage, who).lock.outpoint.txid).slice(0, 8), firstNamedInBrowser: namedAnywhere,
    orphans: [...storage.m.keys()].filter((k) => k.startsWith('arena.lock.orphan.')).length };
  console.log('  FACTS sm1-page-2:', JSON.stringify(facts));
  assert.ok(stored, 'the first lock holds the stake in the federation');
  assert.ok(namedAnywhere, `a stake lock the guardians hold (${tx1.slice(0, 16)}…) is named in no lock record of this browser: written over by the next PLAY after a 6 s "not stored" read - its expiry refund can never be made (${JSON.stringify(facts)})`);
});
