// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-page-4 (state-machine audit, SM-L1 x SM-L2 x SM-L3: the stake lock record, the collect record and lookOwed): AN ORPHANED LOCK
// IS NAMED, AND NEVER COLLECTED. #1584 made keptLockStake copy a lock read "refused" on a reload (3 x not stored, a slow consensus) to
// arena.lock.orphan.* before the next PLAY writes a new lock over the record. But nothing reads arena.lock.orphan.*: lookOwed and refundKept read
// the seats' /stake-lock answer and savedLock (the NEW lock) only. When the guardians accept the first transaction after all, its stake sits under
// the player's refund key; the round's collect refunds the second lock, lookOwed reads the round FINAL with nothing owed, the collect record is
// marked done (never looked at again), and the first lock's stake stays in the federation past its expiry for good.
// Invariant: a round's collect is never final/done while a lock this browser submitted for it (named in any lock record) is still held by the
// federation under this player's refund key.
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
import { playerFor } from '../src/join.js';
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve }).pubkey;
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
      const st = fed.get(txid);
      return JSON.stringify({ block_count: 1200, stored: st === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : st === 'expired' ? { contract_id: 's1', blocks_left: 0 } : null });
    }
    async withdrawableMsat() { throw new Error('Balance is too low to send any amount after fees'); }
    async refund(txid) {
      if (fed.get(txid) !== 'expired') return JSON.stringify({ accepted: false, error: 'not expired' });
      fed.set(txid, 'gone'); return JSON.stringify({ accepted: true });
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


const NODES = ['http://s1.test', 'http://s2.test'];
// the round's seats: its settlement ACCEPTED (paying someone else), no seat names a lock of this player (the round refused its entry), a
// refused-lock hand-over not kept
const seats = async (url) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.includes('/lock-settlement')) return ok({ state: 'ACCEPTED', txid: 'ee'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: 'ab'.repeat(32), msat: '1000' }] } });
  if (u.includes('/stake-lock')) return ok([]);
  if (u.includes('/forfeit')) return { ok: false, status: 409, json: async () => ({}), text: async () => 'no forfeit' };
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'not here' };
};

test('wf1489-sm1-page-4: the collect is never done while the orphaned first lock (accepted late) still holds the stake', async () => {
  const fed = new Map();
  const storage = browser();
  // PLAY: submitted, the guardians slow; the reload reads it not stored three times -> refused
  const a = lockClient(fed, { slow: true, first: 1 });
  const first = await pageLocks(storage, a.LockClient, await dealt());
  const tx1 = toHex(first.outpoint.txid);
  const use = await pageReloads(storage, new a.LockClient());
  // THE NEXT PLAY: a new lock, accepted; the page keeps its collect record (index.html saveCollect after the lock)
  const b = lockClient(fed, { first: 2 });
  const second = await pageLocks(storage, b.LockClient, await dealt());
  await second.accepted;
  const tx2 = toHex(second.outpoint.txid);
  PL.saveCollect(storage, { roundIdHex: toHex(rid), round, invite: INVITE, nodes: NODES, seed, stakeLock: second });
  // THE GUARDIANS' CONSENSUS REACHES THE FIRST TRANSACTION; both locks reach their expiry; the collect refunds the second (its record's)
  fed.set(tx1, 'expired'); fed.set(tx2, 'expired');
  for (const [t] of fed) if (t !== tx1 && t !== tx2) fed.set(t, 'gone');
  const client = new b.LockClient();
  const look1 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  const co = await PL.collectOwed({ look: look1, client, round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: b.LockClient, storage, nodes: NODES, fetcher: seats });
  // THE NEXT LOOK (index.html lookThePayout): final with nothing owed -> markCollectDone
  const look2 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  const done = PL.markCollectDone(storage, toHex(rid), { payout: PL.owedToLine(look2), stake: null }, seed, 0, { look: look2 });
  const st1 = JSON.parse(await client.lockStatus(tx1)).stored;
  const orphanNamesTx1 = [...storage.m].some(([k, v]) => k.startsWith('arena.lock.orphan.') && v.includes(tx1));
  const facts = { reloadUse: use.use, tx1: tx1.slice(0, 8), tx2: tx2.slice(0, 8), orphanNamesTx1, look1: { stake: look1.stake.state, how: look1.stake.how, refundMsat: String(look1.refundMsat) },
    refunded: (co.refund && co.refund.locks || []).map((l) => l.state), look2: { final: look2.final, stake: look2.stake.state, owedMsat: String(look2.owedMsat) },
    recordDone: done, tx1StillStoredExpired: !!st1, tx1Msat: String(first.fields.amountMsat) };
  console.log('  FACTS sm1-page-4:', JSON.stringify(facts));
  assert.ok(orphanNamesTx1, 'the #1584 fix keeps the first lock named in arena.lock.orphan.*');
  assert.ok(st1, 'the first lock holds the stake in the federation, past its expiry');
  assert.ok(!(look2.final && done), `the round's collect is FINAL and its record DONE while the first lock (${tx1.slice(0, 16)}…, ${first.fields.amountMsat} msat, named in arena.lock.orphan.*) is still held by the federation past its expiry under this player's refund key - nothing reads the orphan, the stake is never refunded (${JSON.stringify(facts)})`);
  // kanban #2460: the orphan is owed by refund, the next collect takes it back, and only then is the round final and its record done
  assert.equal(look2.stake.state, 'owed');
  assert.equal(look2.stake.how, 'refund');
  const co2 = await PL.collectOwed({ look: look2, client, round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: b.LockClient, storage, nodes: NODES, fetcher: seats });
  assert.ok(co2.refund && co2.refund.ok, `the orphaned lock is refunded (${JSON.stringify(co2.refund, (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
  assert.equal(JSON.parse(await client.lockStatus(tx1)).stored, null, 'the first lock is no longer stored');
  const look3 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  assert.equal(look3.final, true, 'with every lock of this browser gone the round is final');
  assert.equal(PL.markCollectDone(storage, toHex(rid), { payout: PL.owedToLine(look3), stake: null }, seed, 0, { look: look3 }), true);
});

test('wf1489-sm1-page-4 (kanban #2460): an intent a closed tab left with its transaction named is never final while the guardians store it', async () => {
  const fed = new Map();
  const storage = browser();
  const a = lockClient(fed, { slow: true, first: 7 });
  const first = await pageLocks(storage, a.LockClient, await dealt());
  const tx1 = toHex(first.outpoint.txid);
  // the tab closed before its record was written: only the intent, its transaction named, is kept
  const savedKey = [...storage.m.keys()].find((k) => k.startsWith('arena.lock.saved.'));
  const rec = JSON.parse(storage.getItem(savedKey));
  storage.removeItem(savedKey);
  const tag = savedKey.slice('arena.lock.saved.'.length);
  const sub = { txid: tx1, outputs: [{ role: 'stake', out_idx: 0, amount_msat: rec.fields.amountMsat, computed_expiration: rec.fields.expiration }] };
  if (rec.feeLock) sub.outputs.push({ role: 'fee', out_idx: 1, amount_msat: rec.feeLock.fields.amountMsat, computed_expiration: rec.feeLock.fields.expiration });
  storage.setItem(`arena.lock.intent.${tag}`, JSON.stringify({ v: 2, state: 'intent', atMs: Date.now() - 300000, preimage: rec.preimage, body: rec.body,
    amountMsat: rec.fields.amountMsat, refundPk: rec.fields.refundPk, claimPk: rec.fields.claimPk, txid: tx1,
    outputs: sub.outputs.map((o) => ({ role: o.role, outIdx: o.out_idx, amountMsat: String(o.amount_msat), expiration: o.computed_expiration })) }));
  fed.set(tx1, 'accepted');
  const client = new (lockClient(fed, { first: 50 }).LockClient)();
  const look1 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  assert.equal(look1.final, false, 'stored before its expiry: waiting');
  assert.equal(look1.stake.state, 'waiting');
  fed.set(tx1, 'expired');
  const look2 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  assert.equal(look2.stake.state, 'owed');
  const co = await PL.collectOwed({ look: look2, client, round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: a.LockClient, storage, nodes: NODES, fetcher: seats });
  assert.ok(co.refund && co.refund.ok, 'the intent\'s lock is refunded by the player\'s key, its fields rebuilt from the intent');
  const look3 = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage });
  assert.equal(look3.final, true);
});
