// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-find-entry 1 (state machine audit, entry, release audit #3604): A STAKE SEEN WITH NO STAKE LOCK.
// verifyStakeLock writes the stake lock (round.putStakeLock) and only THEN awaits the fee gate (roundMintsFees -> port.fees()). During that
// await a lock of a LOWER entry of the same player key (a reload mid-join, two tabs, the seed on two devices) is verified at the same seat:
// otherStakedUnderKey(yieldNow) lets the higher entry's rows go (round.yieldEntryLocks: stake_locks, fee_locks, stake_seen ...). The higher
// entry's handler then resumes and, in a round whose gate mints no fee lock (no fee rule known, or a stake too small to mint one), writes
// putStakeSeen for it - after its lock was let go. The seat now holds the higher entry SEEN with no stake lock, beside the lower entry also
// seen: two counted entries of one player key (#1215), one of them with no lock the settlement could claim.
// Invariants: a seen stake has its stake lock; one player key has one counted entry in a round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';
import { CLAIM, joinedWithLock } from './lock-fixture.js';

test('#1489 sm1-entry-1 a lower entry of one key verified while the higher entry\'s /lock awaits the fee gate leaves the higher one seen with no lock', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    // the fixture already verified the fixture entry's fee lock; a second entry of the SAME player key with a LOWER entry id
    let low = null;
    for (let i = 0; i < 64 && !low; i++) {
      const e = { ...s.entry, worldSecret: b32(0x40 + i), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
        stakeLockOutpoint: { txid: b32(0x60 + i), outIdx: 0n } };
      if (Buffer.compare(Buffer.from(entryId(e)), Buffer.from(s.eid)) < 0) low = e;
    }
    assert.ok(low, 'no lower entry id found');
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(low) });
    assert.equal(joined.status, 201, await joined.text());
    const lowId = entryId(low);
    await s.port.put(low.stakeLockOutpoint, s.fields);
    // the federation's fee rule is not known here (or the stake is too small to mint): the gate mints no fee lock
    s.port.feeRule = null;
    // the higher entry's fee-gate read is slow: its first read is held (on ec3322d11 that read came after its stake lock was written;
    // since kanban #3608 it comes before the re-checks and the writes)
    let release; const held = new Promise((r) => { release = r; }); let holding = false;
    const fees = s.port.fees.bind(s.port);
    s.port.fees = async () => {
      if (!holding) { holding = true; await held; }
      return fees();
    };
    const hand = (eid, fields) => fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })
      .then(async (r) => ({ status: r.status, said: (await r.text()).trim().slice(0, 140) }));
    const high = hand(s.eid, s.fields);
    for (let i = 0; i < 200 && !holding; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(holding, 'the higher entry\'s /lock never reached the fee gate');
    const lower = await hand(lowId, s.fields);
    release();
    const higher = await high;
    const facts = {
      higher: higher.status, lower: lower.status, lowerSaid: lower.said,
      highLock: !!s.d.round.stakeLock(s.eid), highSeen: !!s.d.round.stakeSeen(s.eid),
      lowLock: !!s.d.round.stakeLock(lowId), lowSeen: !!s.d.round.stakeSeen(lowId),
    };
    console.log('  FACTS sm1-entry-1:', JSON.stringify(facts));
    assert.ok(!facts.highSeen || facts.highLock, 'the higher entry is SEEN at this seat with no stake lock: counted, but no lock the settlement could claim');
    assert.ok(!facts.lowSeen || facts.lowLock, 'the lower entry is SEEN with no stake lock');
    assert.ok(Number(facts.highSeen) + Number(facts.lowSeen) <= 1, 'two entries of one player key are counted in the round (#1215)');
  } finally { await s.close(); }
});
