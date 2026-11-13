// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE VERIFIES THE PLAYER'S STAKE LOCK BEFORE THE STAKE IS COMMITTED (§23.1 step 5).
//
// Custody is the stake lock (FEDERATION.md, 2026-09-11): the player's
// client locks the net stake in the round's federation as a stock LNv2
// OutgoingContract - payment_image Point(stake_point), claim_pk the round's
// key, refund_pk the player, expiration >= height + 144. "STAKE_COMMITTED is
// recorded once >=5 settlement nodes have VERIFIED the locks: the contract id
// at stake_lock_outpoint equals the hash of a contract whose ..." (§23.1 step
// 5). The federation is reached through a port, as Lightning is.
//
// MEASURED BEFORE (TASKBOOK, acffd59): a signer node of a federation round, a lock
// stored at the entry's outpoint - POST /lock 404, /stake 409 for want of
// Lightning, the federation asked 0 times, the stake never seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';
import { CLAIM, joinedWithLock } from './lock-fixture.js';

// HARNESS KEY: the signer node is handed its claim key, to measure the lock check in
// isolation. The shipping path makes its own: claim-key-own.test.js.
const WITH_KEY = { claimKeyFor: () => CLAIM };
const handOver = (s, fields) => fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(s.eid)}`,
  { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
const stakeStatus = async (s) => (await fetch(`http://127.0.0.1:${s.d.port}/stake?entry=${toHex(s.eid)}`)).status;

test('the player\'s own lock is verified: the signer node asks the federation, the contract is the one it holds, every field matches, and the stake is seen - /stake answers held', async () => {
  const s = await joinedWithLock(WITH_KEY);
  try {
    const before = await stakeStatus(s);
    const r = await handOver(s, s.fields);
    const said = await r.text();
    const seen = s.d.round.stakeSeen(s.eid);
    const facts = {
      stakeBefore: before, lockDoor: r.status, federationAsked: s.port.asked,
      stakeSeenMsat: seen ? String(seen.paidMsat) : null, netStake: String(netStakeMsat(s.entry)),
      stakeAfter: await stakeStatus(s), lockKept: !!s.d.round.stakeLock(s.eid),
    };
    console.log('  FACTS (the player\'s own lock):', JSON.stringify(facts), '|', said.trim().slice(0, 100));
    assert.deepEqual(facts, {
      stakeBefore: 409, lockDoor: 201, federationAsked: 2, stakeSeenMsat: String(netStakeMsat(s.entry)),
      netStake: String(netStakeMsat(s.entry)), stakeAfter: 200, lockKept: true,
    });
  } finally { await s.close(); }
});

test('a lock that is not the entry\'s is refused by name, and the stake stays unseen', async () => {
  const cases = [
    ['no lock at the outpoint', async (s) => { s.port.locks.clear(); return s.fields; }, /holds no lock at the entry's stake_lock_outpoint/],
    ['a contract other than the one stored', async (s) => ({ ...s.fields, amountMsat: s.fields.amountMsat + 1n }), /its id is another/],
    ['a stored lock for the wrong amount', async (s) => { const f = { ...s.fields, amountMsat: s.fields.amountMsat - 1n }; await s.port.put(s.outpoint, f); return f; }, /holds \d+ msat, and the entry's net stake/],
    ['a hash image', async (s) => { const f = { ...s.fields, paymentImage: { kind: 'hash', bytes: s.entry.stakeCommitment } }; await s.port.put(s.outpoint, f); return f; }, /payment image is not the entry's stake point/],
    ['another claim key', async (s) => { const f = { ...s.fields, claimPk: Uint8Array.from([0x02, ...b32(0xc2)]) }; await s.port.put(s.outpoint, f); return f; }, /claim_pk is not this round's attested claim key/],
    ['another refund key', async (s) => { const f = { ...s.fields, refundPk: Uint8Array.from([0x02, ...b32(0x77)]) }; await s.port.put(s.outpoint, f); return f; }, /refund_pk is not the entry's player key/],
    ['too short an expiry', async (s) => { const f = { ...s.fields, expiration: s.port.height + 100 }; await s.port.put(s.outpoint, f); return f; }, /a loser could refund before settlement/],
  ];
  const facts = [];
  for (const [name, make, why] of cases) {
    const s = await joinedWithLock(WITH_KEY);
    try {
      const r = await handOver(s, await make(s));
      const said = await r.text();
      facts.push(name);
      assert.equal(r.status, 409, `${name}: accepted (${said})`);
      assert.match(said, why, `${name}: refused for another reason`);
      assert.equal(s.d.round.stakeSeen(s.eid), null, `${name}: the stake was seen`);
      assert.equal(await stakeStatus(s), 409, `${name}: /stake answered`);
    } finally { await s.close(); }
  }
  console.log(`  ${facts.length} wrong locks refused by name: ${facts.join('; ')}`);
});

test('one lock stakes one signer node: a second entry naming a lock already committed for another is refused, and its stake stays unseen', async () => {
  const s = await joinedWithLock(WITH_KEY);
  try {
    assert.equal((await handOver(s, s.fields)).status, 201);
    // The same entry handing its own lock again is still its own.
    assert.equal((await handOver(s, s.fields)).status, 201);
    // A second entry of the same player, naming the same outpoint - a reload
    // that reused a lock a signer node had already taken, or a player trying one stake twice.
    const second = { ...s.entry, worldSecret: b32(0x17), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const joined = await fetch(`http://127.0.0.1:${s.d.port}/entry`, { method: 'POST', body: encodeEntryContract(second) });
    assert.equal(joined.status, 201, await joined.text());
    const eid2 = entryId(second);
    const r = await fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(eid2)}`,
      { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) });
    const said = await r.text();
    console.log(`  the lock handed for a second entry: ${r.status} ${said.trim()}`);
    assert.equal(r.status, 409, `a second entry was staked by one lock: ${said}`);
    assert.match(said, /already stakes another entry in this round: one lock is one entry/);
    assert.equal(s.d.round.stakeSeen(eid2), null, 'the second entry\'s stake was seen');
    assert.ok(s.d.round.stakeSeen(s.eid), 'the first entry lost its stake');
  } finally { await s.close(); }
});

test('a signer node says where a player\'s verified lock is by its refund key, and nothing for another key (W5a)', async () => {
  const s = await joinedWithLock(WITH_KEY);
  try {
    const ask = async (refund) => {
      const r = await fetch(`http://127.0.0.1:${s.d.port}/stake-lock?round=${toHex(s.rid)}&refund=${refund}`);
      return { status: r.status, body: r.ok ? await r.json() : (await r.text()).trim() };
    };
    const mine = toHex(s.fields.refundPk);
    const before = await ask(mine);
    assert.equal((await handOver(s, s.fields)).status, 201);
    const after = await ask(mine);
    const other = await ask(`02${'77'.repeat(32)}`);
    const bad = await ask('02zz');
    console.log(`  /stake-lock by refund key: before ${before.body.length}, after ${after.body.length} (${after.body[0] && after.body[0].outpoint.slice(0, 20)}...), another key ${other.body.length}, a bad key ${bad.status}`);
    assert.deepEqual([before.status, before.body.length], [200, 0], 'a lock no signer node verified was answered');
    assert.equal(after.body.length, 1);
    assert.equal(after.body[0].outpoint, `${toHex(s.outpoint.txid)}:${s.outpoint.outIdx}`);
    assert.equal(after.body[0].entryId, toHex(s.eid));
    assert.deepEqual(after.body[0].fields, lockFieldsToJson(s.fields));
    assert.deepEqual([other.status, other.body.length], [200, 0], 'another key was answered with this player\'s lock');
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('a round that names no federation takes no lock: its stake is not one', async () => {
  // M3 W7: a paying FEDERATION round naming no federation is no contract - it cannot be made at all.
  await assert.rejects(joinedWithLock(WITH_KEY, { federationId: new Uint8Array(32) }),
    /takes a stake into a FEDERATION and names no federation_id/);
  // AND THE WITHDRAWN THRESHOLD_LN (RULED 2026-09-22 22:59) IS NO ROUND AT ALL: the codec refuses it,
  // and the signer node the fixture started is closed.
  await assert.rejects(joinedWithLock(WITH_KEY, { custody: 'THRESHOLD_LN', federationId: new Uint8Array(32) }),
    /THRESHOLD_LN is not a custody this network has/);
});

// KANBAN #1214 (audit 3 #1210 CONC-1): the one-lock-one-entry check read the store BEFORE the federation was asked (3-5 awaits) and the
// lock was written after them - two POST /lock for two entries of one player with the same lock, at the same moment, both passed the
// check and both were staked by one lock. Now the check is made again, with no await between it and the write.
test('#1214 two entries handing the same lock at the same moment: one is staked, the other refused - and in either order', async () => {
  for (const order of ['first-then-second', 'second-then-first']) {
    const s = await joinedWithLock(WITH_KEY);
    try {
      const second = { ...s.entry, worldSecret: b32(0x18), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
      const joined = await fetch(`http://127.0.0.1:${s.d.port}/entry`, { method: 'POST', body: encodeEntryContract(second) });
      assert.equal(joined.status, 201, await joined.text());
      const eid2 = entryId(second);
      // the federation answers slowly, so both asks are in flight together
      const status = s.port.status.bind(s.port);
      s.port.status = async (o) => { await new Promise((r) => setTimeout(r, 80)); return status(o); };
      const hand = (eid) => fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) })
        .then(async (r) => ({ status: r.status, said: (await r.text()).trim() }));
      const [a, b] = order === 'first-then-second' ? await Promise.all([hand(s.eid), hand(eid2)]) : (await Promise.all([hand(eid2), hand(s.eid)])).reverse();
      // a kept lock (the second entry has no fee lock yet, so its stake waits for it: kept, not seen)
      const staked = [s.d.round.stakeLock(s.eid), s.d.round.stakeLock(eid2)].filter(Boolean).length;
      console.log(`  #1214 ${order}: ${a.status} / ${b.status} - ${[a, b].find((x) => x.status === 409)?.said || 'none refused'}`);
      assert.deepEqual([a.status, b.status].sort(), [201, 409], `${order}: ${a.said} | ${b.said}`);
      assert.equal(staked, 1, `${order}: one lock staked ${staked} entries`);
    } finally { await s.close(); }
  }
});

// KANBAN #1215 (audit 3 #1210 MONEY-1): the settlement keys every lock by its entry's player key. Two entries of one key, each with ITS
// OWN lock, were both staked - and the second took the first one's place in the plan: a loser could void the round's settlement and take
// a lost stake back. One player key stakes one entry in a round; one after the other and at the same moment.
test('#1215 a second entry of the same player key with its own lock is refused - one after the other, and both at once', async () => {
  for (const mode of ['one-after-the-other', 'at-once']) {
    const s = await joinedWithLock(WITH_KEY);
    try {
      const out2 = { txid: b32(0x55), outIdx: 0n };
      const second = { ...s.entry, worldSecret: b32(0x19), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeLockOutpoint: out2 };
      const joined = await fetch(`http://127.0.0.1:${s.d.port}/entry`, { method: 'POST', body: encodeEntryContract(second) });
      assert.equal(joined.status, 201, await joined.text());
      const eid2 = entryId(second);
      await s.port.put(out2, s.fields);
      const status = s.port.status.bind(s.port);
      s.port.status = async (o) => { await new Promise((r) => setTimeout(r, 80)); return status(o); };
      const hand = (eid) => fetch(`http://127.0.0.1:${s.d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) })
        .then(async (r) => ({ status: r.status, said: (await r.text()).trim() }));
      const got = mode === 'at-once' ? await Promise.all([hand(s.eid), hand(eid2)]) : [await hand(s.eid), await hand(eid2)];
      const kept = [s.d.round.stakeLock(s.eid), s.d.round.stakeLock(eid2)].filter(Boolean).length;
      console.log(`  #1215 ${mode}: ${got.map((x) => x.status).join(' / ')} - ${got.find((x) => x.status === 409)?.said || 'none refused'}`);
      assert.equal(kept, 1, `${mode}: ${kept} entries of one key staked`);
      // THE KEY'S ENTRY IS THE LOWEST ENTRY ID (kanban #2477): the same at every seat, whichever lock came first. A higher entry's lock is
      // refused; a lower one's lock coming second takes the key from the higher one (both answered 201, one kept)
      const lower = Buffer.compare(Buffer.from(s.eid), Buffer.from(eid2)) < 0 ? s.eid : eid2;
      assert.ok(s.d.round.stakeLock(lower), `${mode}: the lower entry id is not the one staked`);
      const refused = got.filter((x) => x.status === 409);
      assert.ok(refused.length <= 1 && got.some((x) => x.status === 201), `${mode}: ${got.map((x) => x.said).join(' | ')}`);
      for (const r of refused) assert.match(r.said, /one player key stakes one entry/);
    } finally { await s.close(); }
  }
});
