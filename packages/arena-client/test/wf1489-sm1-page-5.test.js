// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-page-5 (state-machine audit, SM-L1 the stake lock record): A LOCK SUBMITTED BY A TAB THAT CLOSED BEFORE THE ANSWER IS NAMED NOWHERE.
// keptLockStake writes the intent (preimage, handout, amount, refund key, txid: null), asks lockSubmit, and writes the transaction's id into the
// intent only when lockSubmit ANSWERS (onSubmitted). The lock client hands the transaction to the guardians before it answers: a tab closed (a
// reload, a crash, the phone killing the page) in that window leaves an intent with txid null while the guardians accept the transaction. 120 s
// later the next PLAY copies that intent to arena.lock.orphan.* (still no txid) and locks anew; no seat ever saw the first lock (no entry named it),
// no record of the browser names its outpoint, and nothing asks the lock client's log for it (the e-cash sends have sentEcash(key) for exactly this
// window; the lock has no counterpart). The stake sits under the player's refund key, unrefundable from this page.
// Invariant: every transaction the page asked the lock client to submit is named (outpoint) in a lock record, or found again from the wallet.
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
 * acceptance wait never ends (the tab is reloaded before it does). `wallet` (kanban #2459): the 2.0 lock client's operation log, kept in the
 * wallet's own store across a reload (tag -> the submission); lockSubmit keeps the submission under its tag before it hands the transaction
 * on, lockSubmittedFor(tag) finds it again. Without `wallet`: an older lock client, with no lockSubmittedFor. */
function lockClient(fed, { slow = false, first = 1, closesDuringSubmit = false, wallet = null } = {}) {
  const log = [];
  let n = first - 1;
  class Fake {
    static async join() { return new Fake(); }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor() { this.balance = 10n ** 8n; }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String(this.balance); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta, donations, tag) {
      const txid = tx(++n);
      log.push({ lockSubmit: txid, tag });
      this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: 's1', computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: 'f1', computed_expiration: exp, amount_msat: Number(feeMsat) });
      const answer = JSON.stringify({ operation: `op${n}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
      if (wallet && tag) wallet.set(tag, answer);   // the operation log's entry, in the same commit as the transaction it hands on
      fed.set(txid, slow ? 'pending' : 'accepted');
      // THE TAB IS CLOSED WHILE THE SUBMISSION IS ON ITS WAY: the guardians got the transaction (and accept it), the page never hears the answer
      if (closesDuringSubmit) return new Promise(() => {});
      return answer;
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub);
      if (fed.get(s.txid) !== 'accepted') return new Promise(() => {});   // the tab is gone before the guardians answer
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockSubmittedFor(tag) {
      if (!wallet) throw new Error('lockSubmittedFor is not a function of an older lock client');
      return wallet.has(tag) ? wallet.get(tag) : 'null';
    }
    async lockStatus(txid) {
      return JSON.stringify({ block_count: 1001, stored: fed.get(txid) === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : null });
    }
  }
  if (!wallet) delete Fake.prototype.lockSubmittedFor;
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


test('wf1489-sm1-page-5: a lock submitted by a tab closed before lockSubmit answered is named in the browser after the next PLAY', async () => {
  const fed = new Map();
  const wallet = new Map();
  const storage = browser();
  // PLAY: the intent written, the transaction handed to the guardians, the tab closed before the answer came back
  const a = lockClient(fed, { first: 1, closesDuringSubmit: true, wallet });
  // the closed tab's Web Lock goes with it: the first PLAY runs under a lock manager whose hold ends when the tab does (here: at once)
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: (name, opts, fn) => { fn({ name }).catch(() => {}); return Promise.resolve(); } } }, configurable: true, writable: true });
  try { pageLocks(storage, a.LockClient, await dealt()).catch(() => {}); for (let i = 0; i < 50 && !fed.size; i++) await new Promise((r) => setTimeout(r, 5)); }
  finally { if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); }
  for (let i = 0; i < 50 && !fed.size; i++) await new Promise((r) => setTimeout(r, 5));
  const tx1 = [...fed.keys()][0];
  assert.ok(tx1, 'the first transaction reached the guardians');
  const intentKey = [...storage.m.keys()].find((k) => k.startsWith('arena.lock.intent.'));
  const intent = JSON.parse(storage.getItem(intentKey));
  // THE NEXT PAGE, MORE THAN LOCK_INTENT_LIVE_MS LATER (the intent's own clock moved back by that much: the browser's storage is what a reload finds)
  storage.setItem(intentKey, JSON.stringify({ ...intent, atMs: Date.now() - PL.LOCK_INTENT_LIVE_MS - 1000 }));
  const rec = PL.lockRecordOf(storage, who);
  // THE NEXT PLAY: a new lock, accepted at once
  const b = lockClient(fed, { first: 2, wallet });
  const second = await pageLocks(storage, b.LockClient, await dealt());
  await second.accepted;
  const stored = JSON.parse(await new b.LockClient().lockStatus(tx1)).stored;
  const namedAnywhere = [...storage.m].some(([k, v]) => k.startsWith('arena.lock.') && v.includes(tx1));
  const facts = { afterClose: { state: rec.state, txid: rec.record && rec.record.txid }, firstTx: tx1.slice(0, 8), firstStored: !!stored,
    secondTx: toHex(second.outpoint.txid).slice(0, 8), firstNamedInBrowser: namedAnywhere,
    orphans: [...storage.m].filter(([k]) => k.startsWith('arena.lock.orphan.')).map(([, v]) => ({ txid: JSON.parse(v).txid })) };
  console.log('  FACTS sm1-page-5:', JSON.stringify(facts));
  assert.ok(stored, 'the first lock holds the stake in the federation');
  assert.ok(namedAnywhere, `a stake lock the guardians hold (${tx1.slice(0, 16)}…) is named in no lock record of this browser: the tab closed while lockSubmit was on its way, the intent kept txid null, and the next PLAY locked anew - its expiry refund can never be made (${JSON.stringify(facts)})`);
});

test('wf1489-sm1-page-5 (kanban #2459): a lock client that cannot find the unanswered submission refuses the next PLAY - no second stake', async () => {
  const fed = new Map();
  const storage = browser();
  const a = lockClient(fed, { first: 1, closesDuringSubmit: true });
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: (name, opts, fn) => { fn({ name }).catch(() => {}); return Promise.resolve(); } } }, configurable: true, writable: true });
  try { pageLocks(storage, a.LockClient, await dealt()).catch(() => {}); for (let i = 0; i < 50 && !fed.size; i++) await new Promise((r) => setTimeout(r, 5)); }
  finally { if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); }
  assert.equal(fed.size, 1, 'the first transaction reached the guardians');
  const intentKey = [...storage.m.keys()].find((k) => k.startsWith('arena.lock.intent.'));
  const intent = JSON.parse(storage.getItem(intentKey));
  assert.equal(intent.submitting, true, 'the intent says the transaction was handed on before the lock client was asked');
  storage.setItem(intentKey, JSON.stringify({ ...intent, atMs: Date.now() - PL.LOCK_INTENT_LIVE_MS - 1000 }));
  const b = lockClient(fed, { first: 2 });
  await assert.rejects(pageLocks(storage, b.LockClient, await dealt()), /cannot find it: no second lock is made/);
  assert.equal(fed.size, 1, 'no second stake went to the guardians');
  assert.equal(b.log.length, 0);
  assert.equal(PL.lockRecordOf(storage, who).state, 'intent', 'the intent stays where it was');
});

test('wf1489-sm1-page-5 (kanban #2459): a tab closed before it submitted anything leaves an intent the next PLAY locks over', async () => {
  const fed = new Map();
  const wallet = new Map();
  const storage = browser();
  // the intent of a tab closed before its lock client was asked (as keptLockStake writes it, never marked submitting: nothing handed on)
  const intentKey = `arena.lock.intent.${toHex(rid)}.${toHex(player).slice(0, 16)}`;
  const atMs = Date.now() - PL.LOCK_INTENT_LIVE_MS - 1000;
  storage.setItem(intentKey, JSON.stringify({ v: 3, state: 'intent', atMs, submitTag: `arena.lock.x.${atMs}`, txid: null }));
  assert.equal(PL.lockRecordOf(storage, who).state, 'intent');
  const b = lockClient(fed, { first: 2, wallet });
  const second = await pageLocks(storage, b.LockClient, await dealt());
  await second.accepted;
  assert.equal(fed.size, 1, 'one stake, the new PLAY\'s');
  assert.equal(PL.lockRecordOf(storage, who).state, 'accepted');
});
