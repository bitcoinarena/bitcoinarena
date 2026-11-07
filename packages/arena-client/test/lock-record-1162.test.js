// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1162 (the 2026-11-06 state-machine audit): THE STAKE LOCK'S RECORD - submitted -> saved -> committed, with no write-ahead.
//
// The page made the lock first and kept it after, with a raw write; a lock the guardians refused was kept and reused; and the entry
// the lock was named in lived only in memory. Each test below drives the page's own sequence (index.html: lockStake, then - on a
// source without `keep` - saveLock; on a reload savedLock -> keptLockUse, a 'check' read in the federation) and asserts what must
// hold. On the old source each fails: the measure is the FACTS line each prints.
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

/**
 * A lock client and the federation behind it: lockSubmit hands the transaction to `fed` (txid -> 'accepted' | 'refused'), lockAccepted
 * answers as the guardians do, lockStatus reads what they store. `refuse`: the guardians refuse the transaction; `hang`: the tab dies
 * inside lockSubmit, after the transaction went out (the answer never comes).
 */
function lockClient({ refuse = false, hang = false, fed = new Map() } = {}) {
  const log = [];
  let n = 0;
  class Fake {
    static async join() { return new Fake(); }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor() { this.balance = 10n ** 8n; }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String(this.balance); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta) {
      const txid = (++n).toString(16).padStart(2, '0').repeat(32);
      log.push({ lockSubmit: txid });
      this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      fed.set(txid, refuse ? 'refused' : 'accepted');
      if (hang) return new Promise((_, no) => { fed.release = () => no(new Error('the tab is gone')); });   // never answered (released at the test's end)
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
    async lockStatus(txid) {
      log.push({ lockStatus: txid });
      return JSON.stringify({ block_count: 1001, stored: fed.get(txid) === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : null });
    }
  }
  return { LockClient: Fake, log, fed };
}

const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });

/** THE PAGE'S LOCK STEP, as index.html takes it: lockStake with `keep`; a source that does not keep (no `kept` in its answer) saveLock after. */
async function pageLocks(storage, LockClient, stake) {
  const made = await PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient, storage,
    keep: true, federationId: round.federationId });
  if (made.kept === undefined) PL.saveLock(storage, { ...who, stake, lock: made, federationId: round.federationId });
  return made;
}
/** THE PAGE'S RELOAD, as index.html takes it: the kept lock, its use, a 'check' read in the federation first. */
async function pageReloads(storage, client, entry = null) {
  let kept = PL.savedLock(storage, who);
  let use = PL.keptLockUse(kept, { entry, beforeStart: true, beforeClose: true });
  if (use.use === 'check') { kept = await PL.reconcileKeptLock(storage, { ...who, client, waitMs: 1 }); use = PL.keptLockUse(kept, { entry, beforeStart: true, beforeClose: true }); }
  return use;
}
/** Every transaction the lock client submitted is named in this browser: the kept record or the intent. */
const named = (storage, log) => log.filter((l) => l.lockSubmit).map((l) => l.lockSubmit)
  .map((txid) => [...storage.m.values()].some((v) => v.includes(txid)));

test('#1162 a browser too full to keep the lock spends nothing: the room is taken before the lock client is asked (old: the lock made, then the write refused, the join refused, kept nowhere)', async () => {
  const stake = await dealt();
  const storage = browser();
  const { LockClient, log } = lockClient();
  // room for the wallet's few keys and nothing as large as a kept lock
  storage.room = 1200;
  let refused = null;
  try { await pageLocks(storage, LockClient, stake); } catch (e) { refused = e; }
  const facts = { submitted: log.filter((l) => l.lockSubmit).length, refusedWith: refused ? refused.name || 'Error' : null, namedInBrowser: named(storage, log) };
  console.log('  FACTS #1162 quota:', JSON.stringify(facts));
  assert.ok(refused, 'a lock the browser could not keep was made silently');
  assert.ok(named(storage, log).every(Boolean), `a transaction the lock client submitted is kept nowhere in this browser: ${JSON.stringify(facts)}`);
  assert.equal(facts.submitted, 0, 'the lock client was asked although the browser had no room for the lock\'s record');
  // AND A BROWSER WITH ROOM FOR EXACTLY WHAT THE LOCK TAKES AT ITS PEAK: the record goes where the intent was, kept
  const wide = browser();
  await pageLocks(wide, lockClient().LockClient, stake);
  const tight = browser(wide.peak);
  const t = lockClient();
  const made = await pageLocks(tight, t.LockClient, stake);
  await made.accepted;
  assert.notEqual(made.kept, false, 'a lock made in a browser that had room for its intent was not kept');
  assert.ok(named(tight, t.log).every(Boolean));
});

test('#1162 a tab closed between the submission and the save leaves the lock kept (old: the lock made, nothing kept, the next PLAY locks the round again)', async () => {
  const stake = await dealt();
  // THE TAB DIES RIGHT AFTER lockStake ANSWERS: nothing of the page's runs after it
  const storage = browser();
  const a = lockClient();
  const made = await PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient: a.LockClient, storage,
    keep: true, federationId: round.federationId });
  await made.accepted;
  await new Promise((r) => setTimeout(r, 5));
  // THE RELOAD
  const use = await pageReloads(storage, new a.LockClient());
  // AND THE TAB DIES INSIDE lockSubmit, its transaction gone out: the next PLAY is told, not locked over by a second tab at once
  const s2 = browser();
  const h = lockClient({ hang: true });
  PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient: h.LockClient, storage: s2, keep: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  const intent = s2.getItem(`arena.lock.intent.${toHex(rid)}.${toHex(player).slice(0, 16)}`);
  const facts = { keptAfterDeath: !!PL.savedLock(storage, who), reloadUse: use.use, intentBeforeSubmit: !!intent };
  console.log('  FACTS #1162 tab death:', JSON.stringify(facts));
  assert.equal(facts.keptAfterDeath, true, 'a lock made is kept nowhere when the tab dies after lockStake answered');
  assert.equal(use.use, 'reuse', 'the reload did not reuse the lock it made and the guardians hold');
  assert.ok(intent, 'nothing in the browser says a lock was being made when the tab died inside the lock client');
  const second = lockClient();
  await assert.rejects(() => pageLocks(s2, second.LockClient, stake), /another tab is locking/);
  assert.equal(second.log.filter((l) => l.lockSubmit).length, 0, 'a second lock was made over one still being made');
  h.fed.release();
  await new Promise((r) => setTimeout(r, 5));
  // AN INTENT A CLOSED TAB LEFT (older than LOCK_INTENT_LIVE_MS, its transaction named): kept aside, never written over, and the round is locked anew
  const s3 = browser();
  const iKey = `arena.lock.intent.${toHex(rid)}.${toHex(player).slice(0, 16)}`;
  s3.setItem(iKey, JSON.stringify({ ...JSON.parse(intent), atMs: Date.now() - 300000, txid: '77'.repeat(32) }));
  const c = lockClient();
  const m3 = await pageLocks(s3, c.LockClient, stake);
  await m3.accepted;
  assert.ok([...s3.m].some(([k, v]) => k.startsWith('arena.lock.orphan.') && v.includes('77'.repeat(32))), 'the closed tab\'s submitted transaction was written over');
  assert.equal(s3.getItem(iKey), null);
  assert.equal(toHex(PL.savedLock(s3, who).lock.outpoint.txid), toHex(m3.outpoint.txid));
});

test('#1162 a lock the guardians refused is not reused on the reload: read in the federation, refused, and the next PLAY locks anew (old: reused on every reload, the round unjoinable)', async () => {
  const stake = await dealt();
  const storage = browser();
  const r = lockClient({ refuse: true });
  const made = await pageLocks(storage, r.LockClient, stake);
  await assert.rejects(() => made.accepted, /did not accept/);
  const use = await pageReloads(storage, new r.LockClient());
  const facts = { reloadUse: use.use, stateKept: (PL.savedLock(storage, who) || {}).state || null };
  console.log('  FACTS #1162 refused:', JSON.stringify(facts));
  assert.notEqual(use.use, 'reuse', 'a lock the guardians refused was reused after the reload');
  assert.equal(use.use, 'new');
  // AND THE NEXT PLAY MAKES ITS LOCK, KEPT OVER THE REFUSED ONE
  const again = lockClient({ fed: r.fed });
  const second = await pageLocks(storage, again.LockClient, stake);
  await second.accepted;
  await new Promise((x) => setTimeout(x, 5));
  assert.equal(toHex(PL.savedLock(storage, who).lock.outpoint.txid), toHex(second.outpoint.txid));
  assert.equal(PL.savedLock(storage, who).state, 'accepted');
  // A RECORD AN OLDER PAGE KEPT (no state) IS READ, NOT LOST: as submitted, and read in the federation before it is reused
  const legacy = browser();
  const old = JSON.parse(storage.getItem(`arena.lock.saved.${toHex(rid)}.${toHex(player).slice(0, 16)}`));
  delete old.state; delete old.v; delete old.stateMs; delete old.entry;
  legacy.setItem(`arena.lock.saved.${toHex(rid)}.${toHex(player).slice(0, 16)}`, JSON.stringify(old));
  assert.equal(PL.savedLock(legacy, who).state, 'submitted');
  assert.equal((await pageReloads(legacy, new again.LockClient())).use, 'reuse', 'an older page\'s record of an accepted lock was not reused');
});

test('#1162 a lock named in an entry is that entry\'s: a reload before the seats committed it does not reuse it under another entry (old: committedTo only in memory, reused)', async () => {
  const stake = await dealt();
  const storage = browser();
  const a = lockClient();
  const made = await pageLocks(storage, a.LockClient, stake);
  await made.accepted;
  const entryA = b32(0xa1), entryB = b32(0xb2);
  // THE ENTRY GOES OUT (client.js join: stakeLock.onNamed before the POST); 1 of the 2 needed seats takes it, then the reload
  if (PL.bindLockEntry) PL.bindLockEntry(storage, { ...who, entryId: entryA });
  const kept = PL.savedLock(storage, who);
  const use = PL.keptLockUse(kept, { entry: null, beforeStart: true, beforeClose: true });
  let other = null;
  try { if (PL.bindLockEntry) PL.bindLockEntry(storage, { ...who, entryId: entryB }); } catch (e) { other = e.message; }
  PL.markLockCommitted(storage, { ...who, entryId: entryB });
  const facts = { reloadUse: use.use, otherEntryRefused: !!other, committedTo: PL.savedLock(storage, who).committedTo };
  console.log('  FACTS #1162 named entry:', JSON.stringify(facts));
  assert.equal(use.use, 'staked', 'the lock named in entry A was reused for a new entry after the reload');
  assert.match(other || '', /one lock is one entry/);
  assert.equal(facts.committedTo, null, 'a commit to another entry was written over the entry the lock is named in');
  // ITS OWN ENTRY: committed, final
  PL.markLockCommitted(storage, { ...who, entryId: entryA });
  PL.markLockCommitted(storage, { ...who, entryId: entryB });
  assert.equal(PL.savedLock(storage, who).committedTo, toHex(entryA));
  assert.equal(PL.savedLock(storage, who).state, 'committed');
});

test('#1162 two PLAYs at once lock the round once (old: two locks, two stakes spent)', async () => {
  const stake = await dealt();
  const storage = browser();
  const a = lockClient();
  const got = await Promise.allSettled([pageLocks(storage, a.LockClient, stake), pageLocks(storage, a.LockClient, stake)]);
  const facts = { submitted: a.log.filter((l) => l.lockSubmit).length, refused: got.filter((g) => g.status === 'rejected').map((g) => g.reason.message.slice(0, 60)) };
  console.log('  FACTS #1162 two PLAYs:', JSON.stringify(facts));
  assert.equal(facts.submitted, 1, 'the same round and player were locked twice');
  for (const g of got) if (g.status === 'fulfilled') await g.value.accepted;
});

test('#1162 the transition function: terminal states never change, a step not in the table throws', () => {
  assert.ok(PL.lockRecordStep, 'no transition function');
  for (const [from, to] of [['none', 'intent'], ['intent', 'submitted'], ['submitted', 'accepted'], ['submitted', 'refused'], ['accepted', 'committed'], ['refused', 'intent']])
    assert.equal(PL.lockRecordStep(from, to), to);
  for (const [from, to] of [['committed', 'accepted'], ['committed', 'intent'], ['refused', 'accepted'], ['accepted', 'refused'], ['none', 'submitted'], ['accepted', 'intent']])
    assert.throws(() => PL.lockRecordStep(from, to), /a stake lock goes/);
});

// KANBAN #1254 (audit 3 #1210 FIXES-13): the entry is named before it is posted; a post no seat took left the lock "staked" for good in a new tab
test('#1254 a lock named in an entry no seat took is let go of when every seat answered without it; a seat naming it, or one silent seat, keeps it', async () => {
  const stake = await dealt();
  const storage = browser();
  const made = await pageLocks(storage, lockClient().LockClient, stake);
  await made.accepted;
  const entryA = b32(0xa1);
  PL.bindLockEntry(storage, { ...who, entryId: entryA });
  const answered = (list, asked = 2, n = 2) => Object.assign(list, { asked, answered: n, said: [] });
  const outpoint = PL.savedLock(storage, who).lock.outpoint;
  // a seat names the lock under entry A: it is that entry's, kept
  const named = PL.releaseUntakenEntry(storage, { ...who, locks: answered([{ entryId: toHex(entryA), outpoint, fields: {} }]) });
  // one seat did not answer: nothing can be ruled out, kept
  const silent = PL.releaseUntakenEntry(storage, { ...who, locks: answered([], 2, 1) });
  const before = PL.keptLockUse(PL.savedLock(storage, who), { entry: null, beforeStart: true, beforeClose: true }).use;
  // every seat answered, none holds it: let go of, and the new tab uses the lock
  const released = PL.releaseUntakenEntry(storage, { ...who, locks: answered([]) });
  const after = PL.keptLockUse(PL.savedLock(storage, who), { entry: null, beforeStart: true, beforeClose: true }).use;
  console.log('  FACTS #1254:', JSON.stringify({ namedBySeat: named, oneSilent: silent, useBefore: before, released, useAfter: after }));
  assert.equal(named, false); assert.equal(silent, false); assert.equal(before, 'staked');
  assert.equal(released, true); assert.equal(after, 'reuse');
  // a committed lock is never let go of
  PL.bindLockEntry(storage, { ...who, entryId: entryA }); PL.markLockCommitted(storage, { ...who, entryId: entryA });
  assert.equal(PL.releaseUntakenEntry(storage, { ...who, locks: answered([]) }), false);
});
